import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadFullBook } from '../server/downloader.mjs';
import { createLibrary } from '../server/library.mjs';
import { backfillBookCover } from '../server/cover-backfill.mjs';
import { runDownloadWorker } from '../server/download-worker.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const body = '第一章 起点\n这是用于封面下载测试的完整原创文本。\n第二章 终点\n全书完。';
async function fixture(t, cover) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-covers-'));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/full.txt') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); }
    else cover(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const manifest = { id: 'covered', title: '原创封面验收', language: 'zh-Hans', downloadUrl: origin + '/full.txt', source: { url: origin + '/info', coverUrl: origin + '/mislabelled.jpg' } };
  return { root, origin, manifest, requests };
}

test('a whole book publishes its actual cover format locally and gates every image redirect without leaking raw cookies', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/mislabelled.jpg') { res.writeHead(302, { Location: '/actual-image' }); res.end(); }
    else { res.setHeader('Content-Type', 'image/png'); res.end(png); }
  });
  let gates = 0;
  const result = await downloadFullBook(f.root, f.manifest, undefined, { rawCookie: 'session=local-test', beforeRequest: () => { gates++; } });
  const detail = await createLibrary(f.root).detail('covered');
  assert.equal(detail.coverUrl, '/api/books/covered/files/cover');
  assert.equal(detail.metadata.files.cover, 'cover.png');
  assert.deepEqual(await readFile(join(f.root, 'covered', 'cover.png')), png);
  assert.equal(result.cover.status, 'downloaded');
  assert.equal(gates, 3);
  assert.deepEqual(f.requests.filter(r => r.url !== '/full.txt').map(r => r.cookie), ['', '']);
  assert.equal(await readFile(join(f.root, 'covered', 'content.txt'), 'utf8'), body);
});

test('an HTML response posing as an image leaves the full text readable with no broken cover reference', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'image/jpeg'); res.end('<html>not an image</html>'); });
  const result = await downloadFullBook(f.root, f.manifest, undefined, { minDelayMs: 0, maxDelayMs: 0 });
  const detail = await createLibrary(f.root).detail('covered');
  assert.equal(detail.coverUrl, null);
  assert.equal(detail.metadata.files.cover, undefined);
  assert.equal(result.cover.status, 'failed');
  assert.equal(await readFile(join(f.root, 'covered', 'content.txt'), 'utf8'), body);
});

test('an oversized cover is rejected without discarding or downloading the full text again', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); });
  const result = await downloadFullBook(f.root, f.manifest, undefined, { maxCoverBytes: 16, minDelayMs: 0, maxDelayMs: 0 });
  assert.equal(result.cover.code, 413);
  assert.equal((await createLibrary(f.root).scan()).books.length, 1);
  assert.equal(f.requests.filter(r => r.url === '/full.txt').length, 1);
});

test('rate-limited covers return Retry-After with the published text so the worker can cool down without fetching the book again', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { 'Retry-After': '120' }); res.end(); });
  const result = await downloadFullBook(f.root, f.manifest, undefined, { minDelayMs: 0, maxDelayMs: 0 });
  assert.equal(result.cover.code, 429);
  assert.equal(result.cover.retryAfterMs, 120000);
  assert.equal((await createLibrary(f.root).scan()).books.length, 1);
});

test('stopping during an unfinished cover request does not publish an incomplete bundle', async t => {
  let arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  const controller = new AbortController();
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'image/png'); res.write(png.subarray(0, 12)); arrived(); });
  const download = downloadFullBook(f.root, f.manifest, undefined, { signal: controller.signal, minDelayMs: 0, maxDelayMs: 0 });
  // Register the rejection handler before triggering cancellation.
  const rejected = assert.rejects(download);
  try { await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('封面没有开始下载')), 1500); timer.unref(); })]); }
  finally { controller.abort(); }
  await rejected;
  assert.equal((await createLibrary(f.root).scan()).books.length, 0);
});

test('backfilling a published book preserves the text, integrity, dates and custom metadata and skips an existing cover', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(png); });
  f.manifest.userNotes = { shelf: '原创验收' };
  await downloadFullBook(f.root, f.manifest, undefined, { downloadCovers: false });
  const directory = join(f.root, 'covered'), path = join(directory, 'book.json');
  const before = JSON.parse(await readFile(path, 'utf8'));
  const textStat = await stat(join(directory, 'content.txt'));
  const result = await backfillBookCover(directory, { minDelayMs: 0, maxDelayMs: 0 });
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(result.status, 'downloaded');
  assert.equal(after.files.cover, 'cover.png');
  assert.deepEqual(after.integrity, before.integrity);
  assert.deepEqual(after.userNotes, { shelf: '原创验收' });
  assert.equal(after.addedAt, before.addedAt);
  assert.equal(after.downloadedAt, before.downloadedAt);
  assert.equal((await stat(join(directory, 'content.txt'))).mtimeMs, textStat.mtimeMs);
  assert.equal(await readFile(join(directory, 'content.txt'), 'utf8'), body);
  const requests = f.requests.length;
  assert.equal((await backfillBookCover(directory)).status, 'existing');
  assert.equal(f.requests.length, requests);
});

test('cover throttling pauses peer jobs and survives restart after publishing the completed text', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { 'Retry-After': '120' }); res.end(); });
  const queuePath = join(f.root, 'queue.json');
  await writeFile(queuePath, JSON.stringify({ books: [{ manifest: f.manifest }, { manifest: { ...f.manifest, id: 'later' } }], proxy: 'direct', minDelaySeconds: 0, maxDelaySeconds: 0, retrySeconds: 0.03 }));
  const options = { queuePath, libraryRoot: f.root, stateDir: join(f.root, '.state'), once: true };
  const first = await runDownloadWorker(options);
  assert.equal(first.status, 'cooldown');
  assert.equal(first.books.covered.status, 'published');
  assert.equal(first.books.later.status, 'pending');
  assert.ok(Date.parse(first.cooldownUntil) - Date.now() > 100000);
  const requests = f.requests.length;
  const second = await runDownloadWorker(options);
  assert.equal(second.status, 'cooldown');
  assert.equal(f.requests.length, requests);
  assert.equal((await createLibrary(f.root).scan()).books.length, 1);
});
