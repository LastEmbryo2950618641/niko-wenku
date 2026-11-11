import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWenkuBook, parseWenkuInfo, parseWenkuDownloads, fetchWenkuPage } from '../server/wenku8.mjs';
import { selectFullBookDownload } from '../server/downloader.mjs';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const info = `<!doctype html><meta charset="utf-8"><title>雾岛来信 - 林川 - 测试文库</title>
<div id="content"><table><tr><td><span><b>雾岛来信</b>[<a>推一下!</a>]</span></td></tr>
<tr><td>文库分类：测试文库</td><td>小说作者：林川</td><td>文章状态：已完结</td><td>最后更新：2026-11-09</td><td>全文长度：123456字</td></tr></table>
<img src="http://img.wenku8.com/image/0/934/934s.jpg"><span class="hottext"><b>作品Tags：奇幻 校园</b></span><br>
<span class="hottext">最近章节：</span><br><span><a href="/novel/0/934/123.htm">第二卷 归途</a></span><br>
<span class="hottext">内容简介：</span><br><span>海风送来一封信。<br>旅人由此启程。</span>
<a href="/modules/article/packshow.php?id=934&type=txt">分卷</a>
<a href="/modules/article/packshow.php?id=934&type=txtfull">TXT简繁全本</a></div>`;
export const downloads = `<table><caption>《雾岛来信》TXT全文下载</caption><tr><th>更新时间</th><th>文件大小</th><th>G为GBK编码 U为Unicode编码</th></tr><tr><td>2026-11-09</td><td>10K/20K</td><td>
简体(G)（<a href="https://dl.wenku8.com/down.php?type=txt&node=1&id=934">载点一</a>）
简体(U)（<a href="https://dl.wenku8.com/down.php?type=utf8&node=1&id=934">载点一</a><a href="https://dl.wenku8.com/down.php?type=utf8&node=2&id=934">载点二</a>）
繁体(U)（<a href="https://dl.wenku8.com/down.php?type=big5&node=1&id=934">载点一</a>）
<a href="https://unrelated.example/down.php?type=utf8&id=934">广告</a>
<a href="https://dl.wenku8.com/down.php?type=utf8&id=934&fname=chapter">分卷</a>
<a href="https://dl.wenku8.com/down.php?type=utf8&id=999">其他作品</a>
</td></tr></table>`;

test('Wenku source accepts a book ID or actual book URLs and rejects unrelated addresses', () => {
  assert.equal(normalizeWenkuBook('934').id, '934');
  assert.equal(normalizeWenkuBook('https://www.wenku8.net/book/934.htm').infoUrl, 'https://www.wenku8.net/modules/article/articleinfo.php?id=934');
  assert.equal(normalizeWenkuBook('https://www.wenku8.net/modules/article/articleinfo.php?id=934').id, '934');
  assert.throws(() => normalizeWenkuBook('https://example.org/book/934.htm'), /书籍|网址/);
  assert.throws(() => normalizeWenkuBook('https://www.wenku8.net.evil.example/book/934.htm'), /书籍|网址/);
  assert.throws(() => normalizeWenkuBook('../secrets'), /书籍|网址/);
});

test('Wenku metadata preserves title, author, update time, introduction, tags and source details', () => {
  const book = parseWenkuInfo(info, '934');
  assert.equal(book.id, 'wenku8-934');
  assert.equal(book.title, '雾岛来信');
  assert.equal(book.author, '林川');
  assert.equal(book.category, '测试文库');
  assert.equal(book.updatedAt, '2026-11-09');
  assert.equal(book.status, '已完结');
  assert.equal(book.description, '海风送来一封信。\n旅人由此启程。');
  assert.deepEqual(book.tags, ['奇幻', '校园']);
  assert.equal(book.source.wordCount, 123456);
  assert.equal(book.source.latestChapter.title, '第二卷 归途');
  assert.equal(book.source.coverUrl, 'https://img.wenku8.com/image/0/934/934s.jpg');
  assert.match(book.source.downloadPageUrl, /type=txtfull/);
});

test('Wenku whole-file links prefer Simplified UTF-8 and never select volumes or unrelated books', () => {
  const variants = parseWenkuDownloads(downloads, '934');
  assert.equal(variants.length, 4);
  const selected = selectFullBookDownload({ downloadVariants: variants });
  assert.equal(selected.language, 'zh-Hans');
  assert.equal(selected.encoding, 'utf-8');
  assert.match(selected.url, /type=utf8&node=1/);
  const traditional = selectFullBookDownload({ downloadVariants: parseWenkuDownloads(downloads.replace(/<a href="[^"]*type=(?:txt|utf8)[^"]*">[^<]*<\/a>/g, ''), '934') });
  assert.equal(traditional.language, 'zh-Hant');
  assert.equal(traditional.encoding, 'utf-8');
});

test('source parsing stops at authentication and challenge pages rather than inventing download URLs', () => {
  assert.throws(() => parseWenkuDownloads('<form action="login.php"><input type="password"></form>', '934'), /登录/);
  assert.throws(() => parseWenkuInfo('<title>请稍候…</title><div>正在进行安全验证</div>', '934'), /验证/);
  assert.throws(() => parseWenkuDownloads('<table><caption>没有可用下载</caption></table>', '934'), /完整.*TXT|全本/);
  assert.throws(() => parseWenkuDownloads('<meta name="archive-source-url" content="https://www.wenku8.net/login.php"><p>已移除表单的登录页</p>', '934'), /登录/);
});

test('an explicit deleted-book page is missing while an unknown page structure remains an error', () => {
  assert.throws(() => parseWenkuInfo('<div id="content">对不起，该小说不存在或已经删除！</div>', 12), error => error.status === 404);
  assert.throws(() => parseWenkuInfo('<div id="content">页面布局发生变化</div>', 12), error => error.status === 400);
});

test('metadata requests preserve Retry-After when the site throttles a numeric scan', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }));
  await assert.rejects(() => fetchWenkuPage(normalizeWenkuBook(12).infoUrl), error => error.status === 429 && error.retryAfterMs === 120000);
});

test('source CLI prepares one preferred edition without downloading or publishing an empty book', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-source-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const infoFile = join(root, 'info.html'), downloadsFile = join(root, 'downloads.html'), output = join(root, 'prepared.json'), library = join(root, 'library');
  await writeFile(infoFile, info);
  await writeFile(downloadsFile, downloads);
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = [join(project, 'scripts/import-wenku8.mjs'), '934', '--html', infoFile, '--downloads-html', downloadsFile, '--output', output, '--library', library, '--min-delay', '0', '--max-delay', '0'];
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(prepared.language, 'zh-Hans');
  assert.equal(prepared.encoding, 'utf-8');
  assert.equal(prepared.author, '林川');
  assert.equal(prepared.downloadVariants.length, 4);
  assert.deepEqual((await readdir(root)).sort(), ['downloads.html', 'info.html', 'prepared.json']);
  await writeFile(downloadsFile, '<form><input type="password"></form>');
  const failed = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 10000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /登录/);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).title, '雾岛来信');
  assert.deepEqual((await readdir(root)).sort(), ['downloads.html', 'info.html', 'prepared.json']);
});
