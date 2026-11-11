import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { loadDownloadQueue } from '../server/download-queue.mjs';
import { createLibrary } from '../server/library.mjs';
import { fetchWenkuPage } from '../server/wenku8.mjs';
import { downloadFullBook } from '../server/downloader.mjs';

const text = '第一章 启程\n这是并发下载验收使用的原创文本。\n第二章 抵达\n全书完。';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(1800, undefined, { signal: controller.signal }).then(() => { throw new Error('并发任务未按预期推进'); })]); }
  finally { controller.abort(); }
}
async function fixture(t, handler, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-concurrent-'));
  const controller = new AbortController();
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const f = { root, queuePath: join(root, 'queue.json'), libraryRoot: join(root, 'library'), stateDir: join(root, 'state'), signal: controller.signal };
  await writeFile(f.queuePath, JSON.stringify({ concurrency: 2, proxy: 'direct', pollSeconds: 0.03, minDelaySeconds: 0.05, maxDelaySeconds: 0.08, books: ['one', 'two', 'three'].map(id => ({ manifest: { id, title: '原创并发书稿' + id, language: 'zh-Hans', downloadUrl: origin + '/' + id } })), ...extra }));
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { ...f, controller };
}

test('two transfers overlap, share request spacing, and refill a freed slot before the other completes', async t => {
  const responses = new Map(), arrivals = [], two = deferred(), three = deferred();
  const starts = [], realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (...args) => {
    starts.push(performance.now());
    return realFetch(...args);
  });
  let active = 0, peak = 0;
  const f = await fixture(t, (req, res) => {
    arrivals.push({ path: req.url, at: performance.now() });
    active++; peak = Math.max(peak, active);
    res.on('close', () => active--);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write(text.slice(0, 8));
    responses.set(req.url, res);
    if (arrivals.length === 2) two.resolve();
    if (arrivals.length === 3) three.resolve();
  });
  const worker = runDownloadWorker({ ...f, once: true });
  try {
    await within(two.promise);
    assert.equal(peak, 2);
    // The contract spaces client request starts; TCP accepts can bunch when
    // the operating system or the server's event loop is busy.
    assert.ok(starts[1] - starts[0] >= 40, '两个任务必须共用请求间隔');
    const activeState = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
    assert.deepEqual([...activeState.activeBookIds].sort(), ['one', 'two']);
    responses.get('/one').end(text.slice(8));
    await within(three.promise);
    assert.equal(responses.get('/two').writableEnded, false);
    assert.ok(starts[2] - starts[1] >= 40);
    responses.get('/two').end(text.slice(8));
    responses.get('/three').end(text.slice(8));
    const result = await worker;
    assert.equal(peak, 2);
    assert.equal(result.progress.published, 3);
    assert.deepEqual(result.activeBookIds, []);
    assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 3);
    assert.equal(await readFile(join(f.libraryRoot, 'two', 'content.txt'), 'utf8'), text);
  } finally { f.controller.abort(); await worker; }
});

test('authentication failure cancels the second waiting slot before it requests another book', async t => {
  const requests = [];
  const f = await fixture(t, (req, res) => { requests.push(req.url); res.writeHead(403).end(); });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.status, 'auth_required');
  assert.deepEqual(requests, ['/one']);
  assert.equal(result.books.one.status, 'auth_required');
  assert.equal(result.books.two.status, 'pending');
  assert.equal(result.books.two.attempts, 0);
});

test('429 cancels other waiting requests and preserves a global cooldown across both slots', async t => {
  const requests = [];
  const f = await fixture(t, (req, res) => { requests.push(req.url); res.writeHead(429, { 'Retry-After': '120' }).end(); });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.status, 'cooldown');
  assert.deepEqual(requests, ['/one']);
  assert.ok(Date.parse(result.cooldownUntil) > Date.now() + 110000);
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests.length, 1);
});

test('one stop request aborts both live transfers and leaves no partial books published', async t => {
  const two = deferred(); let requests = 0;
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('第一章\n');
    if (++requests === 2) two.resolve();
  });
  const worker = runDownloadWorker({ ...f, once: true });
  try {
    await within(two.promise);
    const lock = JSON.parse(await readFile(join(f.stateDir, 'worker.lock'), 'utf8'));
    await writeFile(join(f.stateDir, 'worker.stop'), JSON.stringify({ token: lock.token }));
    const result = await within(worker);
    assert.equal(result.status, 'stopped');
    assert.deepEqual(result.activeBookIds, []);
    assert.equal(result.books.one.status, 'pending');
    assert.equal(result.books.two.status, 'pending');
    assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 0);
  } finally { f.controller.abort(); await worker; }
});

test('concurrency accepts one or two slots and rejects unsafe or fractional values', async t => {
  const f = await fixture(t, (req, res) => res.end(text));
  assert.equal((await loadDownloadQueue(f.queuePath)).concurrency, 2);
  for (const concurrency of [0, 3, 1.5, '2']) {
    await writeFile(f.queuePath, JSON.stringify({ books: [], concurrency }));
    await assert.rejects(() => loadDownloadQueue(f.queuePath));
  }
});

test('metadata requests and redirects pass through the shared request gate', async t => {
  let fetched = 0, permitted = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    assert.equal(permitted, ++fetched);
    return fetched === 1 ? new Response(null, { status: 302, headers: { Location: '/book/1.htm' } }) : new Response('<html>测试资料</html>');
  });
  const result = await fetchWenkuPage('https://www.wenku8.net/modules/article/articleinfo.php?id=1', { beforeRequest: async () => { permitted++; } });
  assert.match(result, /测试资料/);
  assert.equal(permitted, 2);
});

test('whole-file fallbacks and redirects request permission before every HTTP request', async t => {
  const requested = [];
  const f = await fixture(t, (req, res) => {
    requested.push(req.url);
    if (req.url === '/missing') res.writeHead(404).end();
    else if (req.url === '/redirect') res.writeHead(302, { Location: '/complete' }).end();
    else res.end(text);
  });
  const q = JSON.parse(await readFile(f.queuePath, 'utf8'));
  const origin = new URL(q.books[0].manifest.downloadUrl).origin;
  let permits = 0;
  const result = await downloadFullBook(f.libraryRoot, { id: 'fallback', title: '原创回退验证', downloadVariants: [
    { language: 'zh-Hans', url: origin + '/missing' },
    { language: 'zh-Hant', url: origin + '/redirect' }
  ] }, undefined, { beforeRequest: async () => { permits++; }, signal: f.signal });
  assert.deepEqual(requested, ['/missing', '/redirect', '/complete']);
  assert.equal(permits, 3);
  assert.equal(result.language, 'zh-Hant');
  assert.equal(await readFile(join(f.libraryRoot, 'fallback', 'content.txt'), 'utf8'), text);
});
