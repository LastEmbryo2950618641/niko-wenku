import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadDownloadQueue, acquireWorkerLock, classifyDownloadFailure } from '../server/download-queue.mjs';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { createLibrary } from '../server/library.mjs';

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { root, origin: 'http://127.0.0.1:' + server.address().port, queuePath: join(root, 'queue.json'), libraryRoot: join(root, 'library'), stateDir: join(root, 'state') };
}
const settings = { pollSeconds: 0.03, minDelaySeconds: 0, maxDelaySeconds: 0, retrySeconds: 0.03, maxAttempts: 3, proxy: 'direct' };
const body = '第一章 启程\n一份完整原创测试书稿。\n第二章 归来\n全书完。';
async function queueAt(path, books, extra = {}) { await writeFile(path, JSON.stringify({ ...settings, books, ...extra })); }
function book(id, origin) { return { manifest: { id, title: '测试书籍' + id, author: '本地验收', language: 'zh-Hans', downloadUrl: origin + '/' + id + '.txt' } }; }

test('queue reloads file manifests, ignores disabled tasks, and rejects duplicate IDs', async t => {
  const f = await fixture(t, (req, res) => res.end(body));
  const manifest = { id: 'file-book', title: '最初书名', downloadUrl: f.origin + '/file.txt' };
  await writeFile(join(f.root, 'book.json'), JSON.stringify(manifest));
  await queueAt(f.queuePath, [{ manifest: 'book.json' }, { enabled: false, source: 'wenku8', bookId: '934' }]);
  assert.equal((await loadDownloadQueue(f.queuePath)).jobs[0].manifest.title, '最初书名');
  await writeFile(join(f.root, 'book.json'), JSON.stringify({ ...manifest, title: '更新书名' }));
  assert.equal((await loadDownloadQueue(f.queuePath)).jobs[0].manifest.title, '更新书名');
  await queueAt(f.queuePath, [book('same', f.origin), book('same', f.origin)]);
  await assert.rejects(() => loadDownloadQueue(f.queuePath), /重复/);
});

test('worker downloads one preferred edition, publishes automatically and skips it after restart', async t => {
  const requested = [];
  const f = await fixture(t, (req, res) => { requested.push(req.url); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); });
  await queueAt(f.queuePath, [{ manifest: { id: 'one', title: '持续发布', author: '本地验收', downloadVariants: [
    { language: 'ja', url: f.origin + '/original.txt' }, { language: 'zh-Hant', url: f.origin + '/traditional.txt' }, { language: 'zh-Hans', url: f.origin + '/simplified.txt' }
  ] } }]);
  const first = await runDownloadWorker({ ...f, once: true });
  assert.equal(first.books.one.status, 'published');
  assert.equal(first.books.one.language, 'zh-Hans');
  assert.equal((await createLibrary(f.libraryRoot).detail('one')).chapters.length, 2);
  assert.deepEqual(requested, ['/simplified.txt']);
  const second = await runDownloadWorker({ ...f, once: true });
  assert.equal(second.books.one.status, 'published');
  assert.deepEqual(requested, ['/simplified.txt']);
});

test('a running worker picks up a newly appended book without restarting', async t => {
  const requested = [];
  const f = await fixture(t, (req, res) => { requested.push(req.url); res.end(body); });
  await queueAt(f.queuePath, []);
  const controller = new AbortController();
  let added = false;
  const state = await runDownloadWorker({ ...f, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), onEvent: async event => {
    if (event.event === 'idle' && !added) { added = true; await queueAt(f.queuePath, [book('appended', f.origin)]); }
    else if (event.event === 'published') controller.abort();
  } });
  assert.equal(state.books.appended.status, 'published');
  assert.deepEqual(requested, ['/appended.txt']);
});

test('expired authentication pauses the queue and resumes only after the local cookie file changes', async t => {
  const requested = [];
  const f = await fixture(t, (req, res) => { requested.push(req.url); if (req.headers.cookie !== 'session=fresh-test-value') { res.writeHead(403); res.end(); } else res.end(body); });
  const cookiesFile = join(f.root, 'cookies.txt');
  await writeFile(cookiesFile, 'session=old-test-value');
  await queueAt(f.queuePath, [book('auth', f.origin), book('later', f.origin)], { cookiesFile: 'cookies.txt' });
  const paused = await runDownloadWorker({ ...f, once: true });
  assert.equal(paused.status, 'auth_required');
  assert.deepEqual(requested, ['/auth.txt']);
  await runDownloadWorker({ ...f, once: true });
  assert.deepEqual(requested, ['/auth.txt']);
  await writeFile(cookiesFile, 'session=fresh-test-value');
  const resumed = await runDownloadWorker({ ...f, once: true });
  assert.equal(resumed.books.auth.status, 'published');
  assert.equal(resumed.books.later.status, 'published');
  assert.deepEqual(requested, ['/auth.txt', '/auth.txt', '/later.txt']);
  const rawState = await readFile(join(f.stateDir, 'worker-state.json'), 'utf8');
  assert.ok(!rawState.includes('fresh-test-value'));
  assert.ok(!rawState.includes('old-test-value'));
});

test('temporary errors back off and retry while incomplete downloads never appear in the library', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => { requests++; if (requests === 1) { res.writeHead(503, { 'Retry-After': '0.03' }); res.end(); } else res.end(body); });
  await queueAt(f.queuePath, [book('retry', f.origin)]);
  const first = await runDownloadWorker({ ...f, once: true });
  assert.equal(first.books.retry.status, 'retry_wait');
  assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 0);
  const controller = new AbortController();
  const final = await runDownloadWorker({ ...f, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), onEvent: event => { if (event.event === 'published') controller.abort(); } });
  assert.equal(final.books.retry.status, 'published');
  assert.equal(requests, 2);
});

test('worker honors pause, stops through a control file and prevents concurrent instances', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => { requests++; res.end(body); });
  await queueAt(f.queuePath, [book('paused', f.origin)], { paused: true });
  const paused = await runDownloadWorker({ ...f, once: true });
  assert.equal(paused.status, 'paused');
  assert.equal(requests, 0);
  const lock = await acquireWorkerLock(f.stateDir, { queuePath: f.queuePath, libraryRoot: f.libraryRoot });
  await assert.rejects(() => acquireWorkerLock(f.stateDir, { queuePath: f.queuePath, libraryRoot: f.libraryRoot }), /运行|锁/);
  await lock.release();
  await queueAt(f.queuePath, []);
  const state = await runDownloadWorker({ ...f, signal: AbortSignal.timeout(8000), onEvent: async event => {
    if (event.event === 'idle') {
      const record = JSON.parse(await readFile(join(f.stateDir, 'worker.lock'), 'utf8'));
      await writeFile(join(f.stateDir, 'worker.stop'), JSON.stringify({ token: record.token }));
    }
  } });
  assert.equal(state.status, 'stopped');
  await assert.rejects(() => stat(join(f.stateDir, 'worker.lock')), error => error.code === 'ENOENT');
});

test('error classification never retries authentication or checksum failures as ordinary network failures', () => {
  assert.equal(classifyDownloadFailure({ status: 403, message: 'Forbidden' }).kind, 'auth');
  assert.equal(classifyDownloadFailure({ message: '文件实际为 HTML 登录或验证页面' }).kind, 'auth');
  assert.equal(classifyDownloadFailure({ message: '文件 SHA-256 校验不匹配' }).kind, 'permanent');
  assert.equal(classifyDownloadFailure({ status: 503, retryAfterMs: 120000 }).kind, 'transient');
});

test('a missing simplified whole file falls back once to traditional and records the actual language', async t => {
  const requested = [];
  const f = await fixture(t, (req, res) => {
    requested.push(req.url);
    if (req.url === '/simplified.txt') res.writeHead(404).end();
    else res.end(body);
  });
  await queueAt(f.queuePath, [{ manifest: { id: 'fallback', title: '语言回退', downloadVariants: [
    { language: 'ja', url: f.origin + '/japanese.txt' },
    { language: 'zh-Hant', url: f.origin + '/traditional.txt' },
    { language: 'zh-Hans', url: f.origin + '/simplified.txt' }
  ] } }]);
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.books.fallback.language, 'zh-Hant');
  assert.deepEqual(requested, ['/simplified.txt', '/traditional.txt']);
  assert.equal((await createLibrary(f.libraryRoot).detail('fallback')).language, 'zh-Hant');
});

test('exhausted retries stay stopped until the task retry token changes', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => { requests++; res.writeHead(503).end(); });
  await queueAt(f.queuePath, [book('exhausted', f.origin)], { maxAttempts: 1 });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.books.exhausted.status, 'failed');
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests, 1);
  await queueAt(f.queuePath, [{ ...book('exhausted', f.origin), retryToken: 1 }], { maxAttempts: 1 });
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests, 2);
});

test('stop control aborts an active transfer without publishing a partial book', async t => {
  let stopRequested;
  const stopWritten = new Promise(resolve => { stopRequested = resolve; });
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('第一章\n');
    void readFile(join(f.stateDir, 'worker.lock'), 'utf8').then(record =>
      writeFile(join(f.stateDir, 'worker.stop'), JSON.stringify({ token: JSON.parse(record).token }))
    ).then(stopRequested);
  });
  await queueAt(f.queuePath, [book('interrupted', f.origin)]);
  const result = await runDownloadWorker({ ...f, signal: AbortSignal.timeout(8000) });
  await stopWritten;
  assert.equal(result.status, 'stopped');
  assert.equal(result.books.interrupted.status, 'pending');
  assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 0);
});
