import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibrary, publishBundle } from '../server/library.mjs';
import { decodeBook, indexBook } from '../server/text.mjs';

const sampleText = '第一卷 山海\n第一章 初见\n故事从这里开始。\n第二章 远行\n山海之间，旅人继续前行。\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function dropBook(root, id, extra = {}) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'content.txt'), sampleText);
  await writeFile(join(dir, 'book.json'), JSON.stringify({
    id, title: '山海之旅', author: '示例作者', updatedAt: '2026-11-09',
    description: '一段跨越山海的旅程。', tags: ['奇幻'], files: { text: 'content.txt' }, ...extra
  }));
}
test('JSON + text becomes a searchable, readable book without a build step', async t => {
  const root = await fixture(t);
  await dropBook(root, 'journey');
  const library = createLibrary(root);
  const catalog = await library.scan();
  assert.equal(catalog.books.length, 1);
  assert.equal(catalog.books[0].author, '示例作者');
  const detail = await library.detail('journey');
  assert.equal(detail.chapters.length, 2);
  assert.equal(detail.chapters[0].volume, '第一卷 山海');
  assert.match((await library.chapter('journey', 1)).content, /旅人继续前行/);
  await dropBook(root, 'second', { title: '第二本书' });
  assert.equal((await library.scan()).books.length, 2);
});
test('flat JSON + text works and unknown metadata survives normalization', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'flat.txt'), '没有章节标题，也可以阅读完整文本。');
  await writeFile(join(root, 'flat.json'), JSON.stringify({
    id: 'flat', title: '单文件书籍', authors: ['甲', '乙'], textFile: 'flat.txt',
    introduction: '介绍字段别名', illustrator: '画师'
  }));
  const detail = await createLibrary(root).detail('flat');
  assert.equal(detail.author, '甲 / 乙');
  assert.equal(detail.description, '介绍字段别名');
  assert.equal(detail.metadata.illustrator, '画师');
  assert.equal(detail.chapters[0].title, '全文');
});
test('incomplete, unpublished and malformed books do not break the rest of the library', async t => {
  const root = await fixture(t);
  await dropBook(root, 'valid');
  await writeFile(join(root, 'broken.json'), '{');
  await writeFile(join(root, 'missing.json'), JSON.stringify({ id: 'missing', title: '未完成', files: { text: 'not-here.txt' } }));
  await dropBook(root, 'draft', { published: false });
  const catalog = await createLibrary(root).scan();
  assert.equal(catalog.books.length, 1);
  assert.equal(catalog.invalidEntries.length, 2);
});
test('a manifest cannot read a file outside its own directory', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'private.txt'), 'not a book');
  await dropBook(root, 'unsafe', { files: { text: '../private.txt' } });
  const catalog = await createLibrary(root).scan();
  assert.equal(catalog.books.length, 0);
  assert.match(catalog.invalidEntries[0].message, /路径/);
});
test('publishing is atomic, rejects duplicate IDs, and makes files available to the catalog', async t => {
  const root = await fixture(t);
  const manifest = { id: 'published', title: '完整书稿', author: '作者', files: { text: 'content.txt' } };
  await publishBundle(root, manifest, { 'content.txt': Buffer.from(sampleText) });
  assert.equal((await createLibrary(root).scan()).books.length, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'published', 'book.json'))).title, '完整书稿');
  await assert.rejects(() => publishBundle(root, manifest, { 'content.txt': Buffer.from(sampleText) }), /已存在/);
  await assert.rejects(() => publishBundle(root, { ...manifest, id: 'invalid', files: { text: '../bad.txt' } }, { '../bad.txt': Buffer.from('bad') }), /路径/);
  assert.deepEqual((await readdir(root)).sort(), ['published']);
});
test('chapter indexing supports Chinese numerals, complete text and GBK decoding', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => '第' + (index + 1) + '回 标题\n正文。\n').join('');
  assert.equal(indexBook(hundred).chapters.length, 100);
  assert.equal(indexBook('第一〇〇回 大结局\n终。').chapters.length, 1);
  assert.equal(indexBook('没有分章的书').chapters[0].title, '全文');
  assert.equal(decodeBook(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk').text, '中文');
  assert.equal(decodeBook(Buffer.from('正常中文')).encoding, 'utf-8');
});
test('invalid display metadata is quarantined instead of crashing the reader UI', async t => {
  const root = await fixture(t);
  await dropBook(root, 'invalid-types', { description: { unexpected: 'object' } });
  const result = await createLibrary(root).scan();
  assert.equal(result.books.length, 0);
  assert.match(result.invalidEntries[0].message, /description/);
});

test('concurrent catalog requests share a scan and unchanged contents retain the same revision', async t => {
  const root = await fixture(t);
  await dropBook(root, 'first');
  const library = createLibrary(root);
  const [a, b] = await Promise.all([library.scan(), library.scan()]);
  assert.strictEqual(a, b, 'concurrent callers should join one filesystem scan');
  assert.equal(typeof a.revision, 'string');
  assert.strictEqual(await library.scan({ maxAgeMs: 5000 }), a);
  assert.equal((await library.scan()).revision, a.revision);
  await dropBook(root, 'second');
  const changed = await library.scan();
  assert.equal(changed.books.length, 2);
  assert.notEqual(changed.revision, a.revision);
});

test('catalog index persists summaries and text paths for fast restart, then refreshes on demand', async t => {
  const root = await fixture(t), indexPath = join(root, '..', 'wenku-library-index-' + Date.now() + '.json');
  t.after(() => rm(indexPath, { force: true }));
  await dropBook(root, 'first');
  const first = createLibrary(root, { indexPath });
  await first.scan();
  const saved = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(saved.books[0].manifest, 'first/book.json');
  assert.equal(saved.books[0].text, 'content.txt');
  await dropBook(root, 'second');
  const restarted = createLibrary(root, { indexPath });
  assert.equal((await restarted.scan({ maxAgeMs: 60000 })).books.length, 1, 'fresh persisted metadata should be served without a directory walk');
  assert.equal((await restarted.scan({ maxAgeMs: 0, waitForRefresh: true })).books.length, 2, 'explicit refresh should discover newly published files');
});

test('cover and chapter access validate only their book without discovering unrelated additions', async t => {
  const root = await fixture(t);
  await dropBook(root, 'first', { files: { text: 'content.txt', cover: 'cover.jpg' } });
  await writeFile(join(root, 'first', 'cover.jpg'), Buffer.from('test cover'));
  const library = createLibrary(root), initial = await library.scan();
  await dropBook(root, 'second');
  const results = await Promise.all(Array.from({ length: 12 }, () => library.file('first', 'cover')));
  assert.equal(results.every(file => file.info.size === 10), true);
  assert.match((await library.chapter('first', 0)).content, /故事/);
  assert.strictEqual(await library.scan({ maxAgeMs: 5000 }), initial, 'asset reads must not rebuild the entire catalog');
  assert.equal((await library.scan()).books.length, 2);
  await writeFile(join(root, 'first', 'book.json'), JSON.stringify({ id: 'first', title: 'changed', files: { text: 'content.txt', cover: '../outside.jpg' } }));
  await assert.rejects(() => library.file('first', 'cover'), /文件不存在/);
  await rm(join(root, 'first', 'content.txt'));
  await assert.rejects(() => library.file('first', 'text'), error => error.code === 'ENOENT');
});
