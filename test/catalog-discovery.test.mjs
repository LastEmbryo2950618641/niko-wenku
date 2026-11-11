import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWenkuCatalog, wenkuCatalogUrl } from '../server/wenku8.mjs';
import { loadDownloadQueue } from '../server/download-queue.mjs';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { createLibrary } from '../server/library.mjs';

const manuscript = '第一章 出发\n自动发现测试的完整原创正文。\n第二章 抵达\n全书完。';
const catalog = id => '<h1>最新入库</h1><a href="/book/' + id + '.htm">新书</a>';
const info = id => '<div id="content"><table><tr><td><b>原创书稿' + id + '</b></td></tr><tr><td>小说作者：测试作者</td></tr></table><a href="/modules/article/packshow.php?id=' + id + '&type=txtfull">全本</a></div>';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-auto-range-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { queuePath: join(root, 'queue.json'), stateDir: join(root, 'state'), libraryRoot: join(root, 'library') };
  f.queue = { books: [], ranges: [{ source: 'wenku8', startId: 41, endId: 42, mode: 'metadata' }], autoDiscover: true,
    downloadDiscovered: true, concurrency: 2, workerSlots: { scan: 1, download: 1 },
    proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, pollSeconds: 0.02 };
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  return f;
}
function source(t, getCatalog) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input), id = Number(url.searchParams.get('id'));
    requests.push({ path: url.pathname, id, type: url.searchParams.get('type') });
    if (url.href === wenkuCatalogUrl) return getCatalog();
    if (url.pathname === '/modules/article/articleinfo.php') return new Response(info(id));
    if (url.pathname === '/modules/article/packshow.php') return new Response('<table><caption>TXT全文下载</caption><tr><td><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=big5">繁体</a><a href="https://dl.wenku8.com/down.php?id=' + id + '&type=utf8">简体</a></td></tr></table>');
    if (url.pathname === '/down.php') return new Response(manuscript, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw new Error('Unexpected request');
  });
  return requests;
}

test('catalog parser extracts real source IDs and rejects third-party links, login and changed pages', () => {
  assert.deepEqual(parseWenkuCatalog(catalog(4513) + '<a href="https://wenku8.net/modules/article/articleinfo.php?id=4514">新书</a><a href="https://unrelated.example/book/99999.htm">外部</a><a href="/book/4513.htm">重复</a>'), { highestId: 4514, listedCount: 2 });
  assert.throws(() => parseWenkuCatalog('<input type="password">'), error => error.status === 401);
  assert.throws(() => parseWenkuCatalog('<title>Just a moment</title>'), error => error.status === 403);
  assert.throws(() => parseWenkuCatalog('<h1>列表结构变化</h1>'), error => error.status === 415);
});

test('automatic expansion preserves fingerprints and original queue and remains opt-in', async t => {
  const f = await fixture(t);
  const initial = await loadDownloadQueue(f.queuePath);
  const extended = await loadDownloadQueue(f.queuePath, { discoveredEndId: 45 });
  assert.equal(extended.ranges[0].endId, 45);
  assert.equal(extended.jobs.length, 5);
  assert.equal(extended.jobs[0].fingerprint, initial.jobs[0].fingerprint);
  assert.equal(JSON.parse(await readFile(f.queuePath, 'utf8')).ranges[0].endId, 42);
  await assert.rejects(() => loadDownloadQueue(f.queuePath, { discoveredEndId: 20000 }), /10000/);
  f.queue.autoDiscover = false;
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  assert.equal((await loadDownloadQueue(f.queuePath, { discoveredEndId: 45 })).jobs.length, 2);
  f.queue.autoDiscover = 'true';
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  await assert.rejects(() => loadDownloadQueue(f.queuePath), /autoDiscover/);
});

test('one worker start discovers higher IDs, publishes one language and resumes the extended checkpoint after restart', async t => {
  const f = await fixture(t);
  let reachable = true;
  const requests = source(t, () => { if (!reachable) throw new Error('temporary network failure'); return new Response(catalog(45)); });
  const controller = new AbortController();
  const first = await runDownloadWorker({ ...f, signal: controller.signal, onEvent: event => {
    if (event.event === 'discovered' && event.id === 'wenku8-43') controller.abort();
  } });
  assert.equal(first.discovery.knownMaxId, 45);
  assert.equal(first.scanCheckpoints[0].nextId, 44);
  assert.equal(first.ranges[0].endId, 45);
  const previousScans = requests.filter(r => r.path === '/modules/article/articleinfo.php').map(r => r.id);
  reachable = false;
  const result = await runDownloadWorker({ ...f, once: true });
  assert.equal(result.progress.published, 5);
  assert.equal(result.discovery.knownMaxId, 45);
  assert.equal(result.discovery.status, 'retry_wait');
  assert.equal(result.scanCheckpoints[0].nextId, null);
  assert.deepEqual(requests.filter(r => r.path === '/modules/article/articleinfo.php').map(r => r.id), [...previousScans, 41, 44, 45]);
  assert.equal((await createLibrary(f.libraryRoot).scan()).books.length, 5);
  assert.equal(requests.filter(r => r.path === '/down.php').every(r => r.type === 'utf8'), true);
});

test('periodic discovery detects later additions without restarting the worker', async t => {
  const f = await fixture(t);
  f.queue.discoveryIntervalSeconds = 30;
  await writeFile(f.queuePath, JSON.stringify(f.queue));
  let highest = 42, offset = 0, checks = 0;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + offset);
  source(t, () => { checks++; return new Response(catalog(highest)); });
  const result = await runDownloadWorker({ ...f, once: true, onEvent: event => {
    if (event.event === 'discovered' && event.id === 'wenku8-42') { highest = 44; offset = 31000; }
  } });
  assert.equal(checks, 2);
  assert.equal(result.discovery.knownMaxId, 44);
  assert.equal(result.progress.published, 4);
});

test('catalog authentication and rate limits pause every lane rather than bypassing the failure', async t => {
  for (const status of [401, 429]) {
    const f = await fixture(t);
    const requests = source(t, () => new Response('', { status, headers: { 'Retry-After': '120' } }));
    const result = await runDownloadWorker({ ...f, once: true });
    assert.equal(result.progress.published, 0);
    assert.equal(requests.length, 1);
    if (status === 401) assert.equal(result.authRequired.sourceDiscovery, true);
    else assert.ok(Date.parse(result.cooldownUntil) > Date.now() + 100000);
    t.mock.restoreAll();
  }
});
