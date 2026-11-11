import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDownloadQueue } from '../server/download-queue.mjs';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { createLibrary } from '../server/library.mjs';

async function fixture(t, extra) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-numeric-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = { root, queuePath: join(root, 'queue.json'), stateDir: join(root, 'state'), libraryRoot: join(root, 'library') };
  await writeFile(result.queuePath, JSON.stringify({ proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, ...extra }));
  return result;
}
const originalBody = '第一章 出发\n这是一份用于下载验收的原创小说。\n第二章 抵达\n全书完。';
function info(id) {
  return '<div id="content"><table><tr><td><b>编号原创小说' + id + '</b></td></tr><tr><td>小说作者：原创测试</td><td>最后更新：2026-11-09</td></tr></table><span class="hottext">内容简介：</span><br><span>用于编号下载验证的原创书稿。</span><a href="/modules/article/packshow.php?id=' + id + '&type=txtfull">TXT全本</a></div>';
}
function mockSource(t, { missing = [], auth = [] } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input), id = Number(url.searchParams.get('id'));
    requests.push({ id, path: url.pathname, type: url.searchParams.get('type') });
    if (auth.includes(id)) return new Response('login required', { status: 403 });
    if (missing.includes(id)) return new Response('missing', { status: 404 });
    if (url.pathname === '/modules/article/articleinfo.php') return new Response(info(id), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/modules/article/packshow.php') return new Response('<table><caption>TXT全文下载</caption><tr><td><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=big5">繁体</a><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=utf8">简体</a></td></tr></table>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/down.php') return new Response(originalBody, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw new Error('unexpected request');
  });
  return requests;
}

test('numeric shorthand and bounded ranges expand in order with explicit jobs taking precedence', async t => {
  const f = await fixture(t, { books: [2, '4'], ranges: [{ source: 'wenku8', startId: 1, endId: 4, mode: 'metadata' }] });
  const queue = await loadDownloadQueue(f.queuePath);
  assert.deepEqual(queue.jobs.map(job => job.id), ['wenku8-2', 'wenku8-4', 'wenku8-1', 'wenku8-3']);
  assert.equal(queue.jobs[0].mode, 'download');
  assert.equal(queue.jobs[2].mode, 'metadata');
  for (const range of [
    { startId: 0, endId: 4 }, { startId: 10, endId: 1 }, { startId: 1, endId: 10001 }, { startId: 1.5, endId: 3 }, { startId: 1, endId: 3, mode: 'typo' }
  ]) {
    await writeFile(f.queuePath, JSON.stringify({ ranges: [{ source: 'wenku8', ...range }] }));
    await assert.rejects(() => loadDownloadQueue(f.queuePath));
  }
});

test('numeric whole-book jobs skip missing IDs, publish one preferred edition and resume without redownloads', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 31, endId: 33, mode: 'download' }] });
  const requests = mockSource(t, { missing: [32] });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.books['wenku8-31'].status, 'published');
  assert.equal(result.books['wenku8-32'].status, 'missing');
  assert.equal(result.books['wenku8-33'].status, 'published');
  assert.deepEqual(requests.filter(r => r.path === '/down.php').map(r => [r.id, r.type]), [[31, 'utf8'], [33, 'utf8']]);
  assert.equal(await readFile(join(f.libraryRoot, 'wenku8-31', 'content.txt'), 'utf8'), originalBody);
  assert.equal((await createLibrary(f.libraryRoot).detail('wenku8-33')).language, 'zh-Hans');
  const requestCount = requests.length;
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests.length, requestCount + 2);
});

test('worker checks published Wenku books on startup and replaces only when source metadata changes', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 71, endId: 71, mode: 'download' }] });
  let revision = 1, text = originalBody;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    requests.push(url.pathname);
    if (url.pathname === '/modules/article/articleinfo.php') return new Response(info(71).replace('2026-11-09', `2026-11-0${revision}`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/modules/article/packshow.php') return new Response('<table><caption>TXT全文下载</caption><tr><td><a href="https://dl.wenku8.com/down.php?type=utf8&id=71">简体</a></td></tr></table>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/down.php') return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw new Error('unexpected request: ' + url.href);
  });

  await runDownloadWorker({ ...f, once: true });
  assert.equal(await readFile(join(f.libraryRoot, 'wenku8-71', 'content.txt'), 'utf8'), originalBody);
  requests.length = 0;
  await runDownloadWorker({ ...f, once: true });
  assert.deepEqual(requests, ['/modules/article/articleinfo.php']);

  revision = 2;
  text = originalBody + '\n第三章 更新\n新增内容。';
  await runDownloadWorker({ ...f, once: true });
  assert.equal(await readFile(join(f.libraryRoot, 'wenku8-71', 'content.txt'), 'utf8'), text, JSON.stringify({ requests, book: JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8')).books['wenku8-71'] }));
  assert.equal((await createLibrary(f.libraryRoot).detail('wenku8-71')).chapterCount, 3);
  const finished = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
  assert.equal(finished.updateProgress.checked, 1);
  assert.equal(finished.updateProgress.pending, 0);
  assert.equal(finished.updateProgress.updated, 1);
  assert.equal(finished.workers.update.capacity, 1);
});

test('update checks run beside the existing download lane and once mode drains the update queue', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 72, endId: 72, mode: 'download' }] });
  let blockCheck = false, releaseCheck;
  const checkGate = new Promise(resolve => { releaseCheck = resolve; });
  let genericStartedResolve;
  const genericStarted = new Promise(resolve => { genericStartedResolve = resolve; });
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname === '/modules/article/articleinfo.php') {
      if (blockCheck) await checkGate;
      return new Response(info(72), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/modules/article/packshow.php') return new Response('<table><caption>TXT全文下载</caption><tr><td><a href="https://dl.wenku8.com/down.php?type=utf8&id=72">简体</a></td></tr></table>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/down.php') return new Response(originalBody, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (url.pathname === '/generic.txt') { genericStartedResolve(); return new Response(originalBody, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    throw new Error('unexpected request: ' + url.href);
  });
  await runDownloadWorker({ ...f, once: true });

  await writeFile(f.queuePath, JSON.stringify({ proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, concurrency: 1, workerSlots: { scan: 0, download: 1 }, books: [
    { source: 'wenku8', bookId: 72, mode: 'download' },
    { manifest: { id: 'parallel-download', title: '普通下载', downloadUrl: 'http://example.test/generic.txt' } }
  ] }));
  blockCheck = true;
  const run = runDownloadWorker({ ...f, once: true });
  await Promise.race([genericStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('普通下载被更新检查阻塞')), 1000))]);
  releaseCheck();
  const result = await run;
  assert.equal(result.books['parallel-download'].status, 'published');
  assert.equal(result.updateProgress.checked, 1);
  assert.equal(result.updateProgress.upToDate, 1);
  assert.equal(result.updateProgress.pending, 0);
  assert.deepEqual({ scan: result.workers.scan.capacity, download: result.workers.download.capacity, update: result.workers.update.capacity }, { scan: 0, download: 1, update: 1 });
});

test('numeric metadata mode saves real book records without fetching or publishing a whole text', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 41, endId: 42, mode: 'metadata' }] });
  const requests = mockSource(t);
  const events = [];
  const result = await runDownloadWorker({ ...f, once: true, onEvent: event => events.push(event.event) });
  assert.equal(result.books['wenku8-41'].status, 'discovered');
  assert.equal(result.books['wenku8-42'].status, 'discovered');
  const saved = JSON.parse(await readFile(join(f.stateDir, 'catalog', 'wenku8-41.json'), 'utf8'));
  assert.equal(saved.title, '编号原创小说41');
  assert.equal(saved.author, '原创测试');
  assert.equal(requests.length, 2);
  assert.ok(events.includes('discovering'));
  assert.ok(!events.includes('downloading'));
  assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 0);
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests.length, 2);
});

test('a blocked numeric ID pauses the range instead of running through subsequent IDs', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 51, endId: 55, mode: 'download' }] });
  const requests = mockSource(t, { auth: [51] });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.status, 'auth_required');
  assert.deepEqual(requests.map(r => r.id), [51]);
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests.length, 1);
});

test('rate limiting pauses the entire numeric range and the cooldown survives restart', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 61, endId: 63, mode: 'metadata' }] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }); });
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.status, 'cooldown');
  assert.equal(requests, 1);
  assert.ok(Date.parse(result.cooldownUntil) > Date.now() + 110000);
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests, 1);
});
