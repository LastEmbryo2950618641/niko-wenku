import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { languageLabel, languageRank } from '../shared/language.mjs';
import { downloadFullBook, selectFullBookDownload } from '../server/downloader.mjs';

test('language priority recognizes scripts and regions without assuming unknown Chinese is simplified', () => {
  for (const value of ['zh-Hans', 'zh_CN', 'zh-SG', '简体中文', 'zh-Hans-TW']) assert.equal(languageRank(value), 0);
  for (const value of ['zh-Hant', 'zh_TW', 'zh-HK', '繁體中文', 'zh-Hant-CN']) assert.equal(languageRank(value), 1);
  for (const value of ['zh', '', 'und', 'ja', 'en']) assert.equal(languageRank(value), 2);
  assert.equal(languageLabel('zh-Hans'), '简体中文');
  assert.equal(languageLabel('zh-TW'), '繁体中文');
  assert.equal(languageLabel('zh'), '中文（简繁未标注）');
});

test('whole-file version selection ranks languages, respects explicit URL and isolates version checksums', () => {
  const manifest = {
    language: 'zh-Hant', downloadUrl: 'https://example.org/hant.txt', integrity: { sha256: 'traditional-hash' },
    downloadVariants: [{ language: 'ja', url: 'https://example.org/ja.txt' }, { language: 'zh-Hans', url: 'https://example.org/hans.txt' }]
  };
  const selected = selectFullBookDownload(manifest);
  assert.equal(selected.language, 'zh-Hans');
  assert.equal(selected.integrity, undefined);
  assert.equal(selectFullBookDownload(manifest, 'https://example.org/explicit.txt').url, 'https://example.org/explicit.txt');
  assert.throws(() => selectFullBookDownload({}), /下载入口/);
});

for (const scenario of [
  { id: 'simplified', languages: ['ja', 'zh-Hant', 'zh-Hans'], expected: 'zh-Hans', content: '第一章 开始\n这是一份完整简体文本。' },
  { id: 'traditional', languages: ['ja', 'zh-Hant'], expected: 'zh-Hant', content: '第一章 開始\n這是一份完整繁體文本。' },
  { id: 'other', languages: ['ja'], expected: 'ja', content: 'Complete original-language text.' }
]) test('full download chooses ' + scenario.id + ' when higher-priority versions are absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-language-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requested = [];
  const server = createServer((req, res) => { requested.push(req.url); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(scenario.content); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await downloadFullBook(root, {
    id: scenario.id, title: '语言优先级测试', language: 'ja',
    downloadVariants: scenario.languages.map(language => ({ language, url: origin + '/' + language + '.txt', encoding: 'utf-8' }))
  });
  assert.deepEqual(requested, ['/' + scenario.expected + '.txt']);
  const saved = JSON.parse(await readFile(join(root, scenario.id, 'book.json'), 'utf8'));
  assert.equal(saved.language, scenario.expected);
  assert.equal(saved.downloadVariants, undefined);
  assert.equal(await readFile(join(root, scenario.id, 'content.txt'), 'utf8'), scenario.content);
});

test('a missing Simplified file falls back to Traditional without downloading multiple book bodies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-missing-language-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requested = [];
  let successfulBodies = 0;
  const server = createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/simplified.txt') { res.writeHead(404); res.end(); return; }
    successfulBodies++;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('第一章 開始\n完整繁體正文。');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await downloadFullBook(root, { id: 'fallback', title: '缺失版本测试', downloadVariants: [
    { language: 'ja', url: origin + '/original.txt' },
    { language: 'zh-Hant', url: origin + '/traditional.txt' },
    { language: 'zh-Hans', url: origin + '/simplified.txt' }
  ] }, undefined, { minDelayMs: 0, maxDelayMs: 0 });
  assert.deepEqual(requested, ['/simplified.txt', '/traditional.txt']);
  assert.equal(successfulBodies, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'fallback', 'book.json'), 'utf8')).language, 'zh-Hant');
});

test('authentication failure stops the book task without trying lower-priority language editions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-auth-language-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requested = [];
  const server = createServer((req, res) => { requested.push(req.url); res.writeHead(403); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(() => downloadFullBook(root, { id: 'blocked', title: '登录测试', downloadVariants: [
    { language: 'zh-Hans', url: origin + '/simplified.txt' },
    { language: 'zh-Hant', url: origin + '/traditional.txt' }
  ] }), error => error.status === 403);
  assert.deepEqual(requested, ['/simplified.txt']);
});
