import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppServer } from '../server/app.mjs';

test('HTTP publish -> catalog -> chapter -> full download works; cross-origin writes are blocked', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-http-'));
  const webRoot = join(base, 'dist');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html>local archive</html>');
  const server = await createAppServer({ libraryRoot: join(base, 'library'), webRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(base, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const payload = {
    manifest: { id: 'http-book', title: 'HTTP测试书', author: '测试', files: { text: 'content.txt' } },
    files: [{ name: 'content.txt', base64: Buffer.from('第一章 开端\n第一章正文。\n第二章 终章\n全书完。').toString('base64') }]
  };
  const empty = await fetch(origin + '/api/library');
  const initialEtag = empty.headers.get('etag');
  assert.ok(initialEtag);
  assert.equal((await empty.json()).books.length, 0);
  assert.equal((await fetch(origin + '/api/library', { headers: { 'If-None-Match': initialEtag } })).status, 304);
  const response = await fetch(origin + '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: origin }, body: JSON.stringify(payload) });
  assert.equal(response.status, 201);
  const catalog = await fetch(origin + '/api/library', { headers: { 'If-None-Match': initialEtag } });
  assert.equal(catalog.status, 200);
  const etag = catalog.headers.get('etag');
  assert.notEqual(etag, initialEtag);
  assert.equal((await catalog.json()).books.length, 1);
  const unchanged = await fetch(origin + '/api/library', { headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  await mkdir(join(base, 'library', 'second'));
  await writeFile(join(base, 'library', 'second', 'book.json'), JSON.stringify({ id: 'second', title: '新增', files: { text: 'content.txt' } }));
  await writeFile(join(base, 'library', 'second', 'content.txt'), '完整正文');
  const forced = await fetch(origin + '/api/library?refresh=1', { headers: { 'If-None-Match': etag } });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).books.length, 2);
  const detail = await (await fetch(origin + '/api/books/http-book')).json();
  assert.equal(detail.chapters.length, 2);
  assert.match((await (await fetch(origin + '/api/books/http-book/chapters/1')).json()).content, /全书完/);
  assert.match(await (await fetch(origin + '/api/books/http-book/files/text')).text(), /第一章正文/);
  const rejected = await fetch(origin + '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: 'https://unrelated.example' }, body: JSON.stringify(payload) });
  assert.equal(rejected.status, 403);
  assert.equal((await fetch(origin + '/secrets/cookies.json')).status, 404);
});

test('library preview provides a first page while the full catalog continues loading', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-preview-'));
  const libraryRoot = join(base, 'library'), webRoot = join(base, 'dist');
  await mkdir(webRoot);
  await mkdir(libraryRoot);
  for (let index = 0; index < 30; index++) {
    const folder = join(libraryRoot, 'book-' + String(index).padStart(2, '0'));
    await mkdir(folder);
    await writeFile(join(folder, 'book.json'), JSON.stringify({ id: 'book-' + String(index).padStart(2, '0'), title: '书籍 ' + index, language: index === 29 ? 'zh-Hans' : 'en', files: { text: 'content.txt' } }));
    await writeFile(join(folder, 'content.txt'), '完整正文');
  }
  const server = await createAppServer({ libraryRoot, webRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/library?preview=1');
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.books.length, 24);
  assert.equal(preview.books[0].id, 'book-29');
  assert.equal(preview.stats.total, 30);
  assert.equal(preview.partial, true);
  assert.equal((await fetch('http://127.0.0.1:' + server.address().port + '/api/library')).status, 200);
});
