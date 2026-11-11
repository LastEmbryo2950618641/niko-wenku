import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createAppServer } from '../server/app.mjs';

test('single-book source command downloads one complete edition through its child worker and immediately serves JSON plus text', { timeout: 20000 }, async t => {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'wenku-source-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = '第一章 来信\n海风送来一封信。\n第二章 归途\n这是用于验收的原创完整书稿。\n';
  const infoFile = join(root, 'info.html'), downloadsFile = join(root, 'downloads.html');
  await writeFile(infoFile, `<div id="content"><table><tr><td><b>海风来信</b></td></tr><tr><td>小说作者：本地验收</td><td>最后更新：2026-11-09</td></tr></table><span class="hottext">内容简介：</span><br><span>用于验证完整发布流程的原创短篇。</span><a href="/modules/article/packshow.php?id=934&type=txtfull">TXT简繁全本</a></div>`);
  await writeFile(downloadsFile, `<table><caption>《海风来信》TXT全文下载</caption><tr><td><a href="http://dl.wenku8.com/down.php?type=big5&node=1&id=934">繁体</a><a href="http://dl.wenku8.com/down.php?type=utf8&node=1&id=934">简体</a></td></tr></table>`);
  const requested = [];
  const sockets = new Set();
  const upstream = createServer((req, res) => { requested.push(req.url); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    sockets.add(socket);
    const target = connect(upstream.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    sockets.add(target);
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  const library = join(root, 'library');
  const child = spawn(process.execPath, [join(project, 'scripts/import-wenku8.mjs'), '934', '--html', infoFile, '--downloads-html', downloadsFile, '--output', join(root, 'prepared.json'), '--library', library, '--state-dir', join(root, 'state'), '--download', '--proxy', 'http://127.0.0.1:' + proxy.address().port, '--min-delay', '0', '--max-delay', '0'], {
    cwd: project, windowsHide: true, signal: AbortSignal.timeout(15000), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(exitCode, 0, output);
  assert.deepEqual(requested, ['/down.php?type=utf8&node=1&id=934']);
  assert.deepEqual((await readdir(join(library, 'wenku8-934'))).sort(), ['book.json', 'content.txt']);
  const metadata = JSON.parse(await readFile(join(library, 'wenku8-934/book.json'), 'utf8'));
  assert.equal(metadata.language, 'zh-Hans');
  assert.equal(metadata.author, '本地验收');
  assert.equal(metadata.chapterCount, 2);
  assert.equal(metadata.downloadVariants, undefined);
  const app = await createAppServer({ libraryRoot: library, webRoot: join(project, 'dist') });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const origin = 'http://127.0.0.1:' + app.address().port;
  const catalog = await (await fetch(origin + '/api/library')).json();
  assert.equal(catalog.books.length, 1);
  assert.equal(catalog.books[0].title, '海风来信');
  assert.equal(catalog.books[0].language, 'zh-Hans');
  assert.equal(await (await fetch(origin + catalog.books[0].downloadUrl)).text(), body);
  assert.match((await (await fetch(origin + '/api/books/wenku8-934/chapters/1')).json()).content, /原创完整书稿/);
});
