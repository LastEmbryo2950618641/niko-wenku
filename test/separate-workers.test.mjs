import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { loadDownloadQueue } from '../server/download-queue.mjs';

const body = '第一章 出发\n仅供本地验收的完整原创书稿。\n第二章 抵达\n全书完。';
const info = id => '<div id="content"><table><tr><td><b>原创资料' + id + '</b></td></tr><tr><td>小说作者：原创验收</td></tr></table></div>';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(1500, undefined, { signal: controller.signal }).then(() => { throw new Error('扫描与下载没有分别推进'); })]); }
  finally { controller.abort(); }
}
async function fixture(t, extra) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-separate-'));
  const controller = new AbortController();
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { root, queuePath: join(root, 'queue.json'), stateDir: join(root, 'state'), libraryRoot: join(root, 'library'), controller, signal: controller.signal };
  await writeFile(f.queuePath, JSON.stringify({ concurrency: 2, workerSlots: { scan: 1, download: 1 }, proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, pollSeconds: 0.03, ...extra }));
  return f;
}

test('one dedicated scan slot and one download slot progress independently without borrowing each other', async t => {
  const scanControls = new Map(), downloadControls = new Map();
  const firstPair = deferred(), scanTwo = deferred(), downloadTwo = deferred();
  const f = await fixture(t, { books: [
    { source: 'wenku8', bookId: 501, mode: 'metadata' },
    { source: 'wenku8', bookId: 502, mode: 'metadata' },
    ...['one', 'two'].map(id => ({ manifest: { id, title: '原创书稿' + id, language: 'zh-Hans', downloadUrl: 'https://original.test/' + id } }))
  ] });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'www.wenku8.net') {
      const id = Number(url.searchParams.get('id'));
      const pending = new Promise((resolve, reject) => {
        scanControls.set(id, () => resolve(new Response(info(id))));
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      if (scanControls.size === 2) scanTwo.resolve();
      if (scanControls.size && downloadControls.size) firstPair.resolve();
      return pending;
    }
    const id = url.pathname.slice(1);
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(body.slice(0, 4)));
      downloadControls.set(id, () => { controller.enqueue(new TextEncoder().encode(body.slice(4))); controller.close(); });
      options.signal.addEventListener('abort', () => { try { controller.error(options.signal.reason); } catch {} }, { once: true });
    } });
    if (downloadControls.size === 2) downloadTwo.resolve();
    if (scanControls.size && downloadControls.size) firstPair.resolve();
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  const worker = runDownloadWorker({ ...f, once: true });
  try {
    await within(firstPair.promise);
    assert.equal(scanControls.size, 1);
    assert.equal(downloadControls.size, 1);
    const active = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
    assert.deepEqual(active.workers.scan.activeBookIds, ['wenku8-501']);
    assert.deepEqual(active.workers.download.activeBookIds, ['one']);
    scanControls.get(501)();
    await within(scanTwo.promise);
    assert.equal(downloadControls.size, 1);
    downloadControls.get('one')();
    await within(downloadTwo.promise);
    assert.equal(scanControls.size, 2);
    scanControls.get(502)();
    downloadControls.get('two')();
    const result = await worker;
    assert.equal(result.progress.discovered, 2);
    assert.equal(result.progress.published, 2);
    assert.equal(await readFile(join(f.libraryRoot, 'two', 'content.txt'), 'utf8'), body);
  } finally { f.controller.abort(); await worker; }
});

test('restart resumes after completed and missing scan IDs and preserves a durable next-ID checkpoint', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 601, endId: 604, mode: 'metadata' }] });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const id = Number(new URL(input).searchParams.get('id'));
    requested.push(id);
    return id === 602 ? new Response('missing', { status: 404 }) : new Response(info(id));
  });
  const first = await runDownloadWorker({ ...f, onEvent: event => { if (event.event === 'missing') f.controller.abort(); } });
  assert.deepEqual(requested, [601, 602]);
  assert.equal(first.scanCheckpoints[0].nextId, 603);
  assert.equal(first.scanCheckpoints[0].lastCompletedId, 602);
  const secondController = new AbortController();
  const second = await runDownloadWorker({ ...f, signal: secondController.signal, onEvent: event => { if (event.event === 'discovered') secondController.abort(); } });
  assert.deepEqual(requested, [601, 602, 603]);
  assert.equal(second.scanCheckpoints[0].nextId, 604);
  assert.equal(second.books['wenku8-601'].status, 'discovered');
  assert.equal(second.books['wenku8-602'].status, 'missing');
});

test('an empty download lane reports waiting for tasks while the scan lane completes normally', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 701, endId: 701, mode: 'metadata' }] });
  t.mock.method(globalThis, 'fetch', async () => new Response(info(701)));
  let idleWorker;
  const state = await runDownloadWorker({ ...f, once: true, onEvent: async event => {
    if (event.event === 'idle') idleWorker = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8')).workers.download;
  } });
  assert.equal(idleWorker.status, 'waiting_for_tasks');
  assert.deepEqual(idleWorker.activeBookIds, []);
  assert.equal(state.workers.download.pending, 0);
  assert.equal(state.workers.download.completed, 0);
  assert.equal(state.workers.download.status, 'stopped');
  assert.equal(state.scanCheckpoints[0].nextId, null);
});

test('dedicated slot settings must be integer capacities matching the total concurrency', async t => {
  const f = await fixture(t, { books: [] });
  assert.deepEqual((await loadDownloadQueue(f.queuePath)).workerSlots, { scan: 1, download: 1, update: 1 });
  for (const workerSlots of [{ scan: 2, download: 1 }, { scan: 0.5, download: 1.5 }, { scan: -1, download: 3 }, { scans: 1, download: 1 }, { scan: 1, download: 1, update: 2 }]) {
    await writeFile(f.queuePath, JSON.stringify({ books: [], concurrency: 2, workerSlots }));
    await assert.rejects(() => loadDownloadQueue(f.queuePath));
  }
});
