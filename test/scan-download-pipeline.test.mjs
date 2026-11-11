import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { loadDownloadQueue } from '../server/download-queue.mjs';
import { createLibrary } from '../server/library.mjs';

const body = '第一章 出发\n用于流水线回归测试的完整原创书稿。\n第二章 抵达\n全书完。';
const info = id => '<div id="content"><table><tr><td><b>流水线书稿' + id + '</b></td></tr><tr><td>小说作者：原创测试</td></tr></table><a href="/modules/article/packshow.php?id=' + id + '&type=txtfull">全本</a></div>';
const downloads = id => '<table><caption>TXT全文下载</caption><tr><td><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=big5">繁体</a><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=utf8">简体</a></td></tr></table>';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(3000, undefined, { signal: controller.signal }).then(() => { throw new Error('扫描未向下载工位交接'); })]); }
  finally { controller.abort(); }
}
async function fixture(t, startId, endId, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { root, queuePath: join(root, 'queue.json'), stateDir: join(root, 'state'), libraryRoot: join(root, 'library') };
  f.queue = { books: [], ranges: [{ source: 'wenku8', startId, endId, mode: 'metadata' }], downloadDiscovered: enabled,
    concurrency: 2, workerSlots: { scan: 1, download: 1 }, proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, pollSeconds: 0.03 };
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  return f;
}
function source(t, onDownload) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input), id = Number(url.searchParams.get('id'));
    requests.push({ id, path: url.pathname, type: url.searchParams.get('type') });
    if (url.pathname === '/modules/article/articleinfo.php') return new Response(info(id));
    if (url.pathname === '/modules/article/packshow.php') return new Response(downloads(id));
    if (url.pathname === '/down.php') return onDownload ? onDownload(id, options) : new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw new Error('unexpected request');
  });
  return requests;
}

test('discovered IDs feed one download slot while the dedicated scanner continues', async t => {
  const f = await fixture(t, 801, 803);
  const controller = new AbortController(), started = deferred(), scansDone = deferred();
  let release;
  const requests = source(t, (id, options) => {
    if (id !== 801) return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const stream = new ReadableStream({ start(output) {
      output.enqueue(new TextEncoder().encode(body.slice(0, 4)));
      release = () => { output.enqueue(new TextEncoder().encode(body.slice(4))); output.close(); };
      options.signal.addEventListener('abort', () => { try { output.error(options.signal.reason); } catch {} }, { once: true });
    } });
    started.resolve();
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  const worker = runDownloadWorker({ ...f, signal: controller.signal, once: true, onEvent: event => {
    if (event.event === 'discovered' && event.id === 'wenku8-803') scansDone.resolve();
  } });
  try {
    await within(started.promise);
    await within(scansDone.promise);
    const active = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
    assert.deepEqual(active.workers.download.activeBookIds, ['wenku8-801']);
    assert.equal(active.workers.scan.completed, 3);
    assert.equal(active.scanCheckpoints[0].nextId, null);
    release();
    const result = await within(worker);
    assert.equal(result.progress.published, 3);
    assert.equal(result.workers.scan.completed, 3);
    assert.equal(result.workers.download.completed, 3);
    assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 3);
    assert.equal(await readFile(join(f.libraryRoot, 'wenku8-803', 'content.txt'), 'utf8'), body);
    assert.deepEqual(requests.filter(r => r.path === '/down.php').map(r => [r.id, r.type]), [[801, 'utf8'], [802, 'utf8'], [803, 'utf8']]);
    assert.equal(requests.filter(r => r.path === '/modules/article/articleinfo.php').length, 3);
  } finally { controller.abort(); await worker; }
});

test('enabling handoff drains already discovered IDs without resetting the scan checkpoint', async t => {
  const f = await fixture(t, 901, 903, false), controller = new AbortController();
  const requests = source(t);
  const first = await runDownloadWorker({ ...f, signal: controller.signal, onEvent: event => {
    if (event.event === 'discovered' && event.id === 'wenku8-902') controller.abort();
  } });
  assert.equal(first.scanCheckpoints[0].nextId, 903);
  f.queue.downloadDiscovered = true;
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.progress.published, 3, JSON.stringify({ states: Object.fromEntries(Object.entries(result.books).map(([id, value]) => [id, value.status])), files: (await createLibrary(f.libraryRoot).scan()).books.map(book => book.id) }));
  assert.equal(result.scanCheckpoints[0].nextId, null);
  assert.deepEqual(requests.filter(r => r.path === '/modules/article/articleinfo.php').map(r => r.id), [901, 902, 903]);
  const count = requests.length;
  await runDownloadWorker({ ...f, once: true });
  assert.equal(requests.length, count);
});

test('interrupted handoff retries the download without rescanning a completed ID', async t => {
  const f = await fixture(t, 1001, 1001), controller = new AbortController();
  const requests = source(t);
  const first = await runDownloadWorker({ ...f, signal: controller.signal, once: true, onEvent: event => {
    if (event.event === 'downloading') controller.abort();
  } });
  assert.equal(first.books['wenku8-1001'].status, 'pending');
  assert.equal(first.scanCheckpoints[0].nextId, null);
  assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 0);
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.progress.published, 1);
  assert.equal(requests.filter(r => r.path === '/modules/article/articleinfo.php').length, 1);
  assert.equal(await readFile(join(f.libraryRoot, 'wenku8-1001', 'content.txt'), 'utf8'), body);
});

test('downloadDiscovered rejects non-boolean values instead of silently leaving downloads idle', async t => {
  const f = await fixture(t, 1101, 1101);
  f.queue.downloadDiscovered = 'true';
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  await assert.rejects(() => loadDownloadQueue(f.queuePath));
});
