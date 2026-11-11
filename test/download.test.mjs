import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadFullBook, cookieHeaderFor } from '../server/downloader.mjs';
import { createLibrary } from '../server/library.mjs';

async function server(t, handler) {
  const srv = createServer(handler);
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }));
  return 'http://127.0.0.1:' + srv.address().port;
}
test('direct full-text download produces JSON + a complete file ready for the UI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = '第一回 初始\n这是一本完整的测试书。\n第二回 结束\n全书完。\n';
  const url = await server(t, (req, res) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); });
  const receipt = await downloadFullBook(root, { id: 'downloaded', title: '下载测试', author: '测试' }, url);
  assert.equal(receipt.bytes, Buffer.byteLength(body));
  assert.equal(await readFile(join(root, 'downloaded', 'content.txt'), 'utf8'), body);
  assert.equal((await createLibrary(root).detail('downloaded')).chapters.length, 2);
});
test('HTML login/challenge pages are never published as book files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-html-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await server(t, (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>请先登录</html>'); });
  await assert.rejects(() => downloadFullBook(root, { id: 'bad', title: '失败样本' }, url), /HTML|登录/);
  assert.equal((await createLibrary(root).scan()).books.length, 0);
});
test('cookie scope respects domain, path, expiry and secure transport', () => {
  const cookies = [
    { name: 'session', value: 'secret', domain: '.wenku8.net', path: '/', secure: true, expires: -1 },
    { name: 'old', value: 'expired', domain: '.wenku8.net', expires: 1 },
    { name: 'admin', value: 'private', domain: '.wenku8.net', path: '/admin' }
  ];
  assert.equal(cookieHeaderFor('https://www.wenku8.net/book/1.htm', cookies), 'session=secret');
  assert.equal(cookieHeaderFor('https://dl.wenku8.com/file.txt', cookies), '');
  assert.equal(cookieHeaderFor('http://www.wenku8.net/book/1.htm', cookies), '');
});
