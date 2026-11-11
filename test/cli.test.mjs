import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'scripts', 'cli.mjs');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'wenku-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const library = join(base, 'library');
  const book = join(library, 'sample-book');
  await mkdir(book, { recursive: true });
  await writeFile(join(book, 'book.json'), JSON.stringify({
    id: 'sample-book', title: '星海旅人', author: '测试作者', category: '奇幻', status: '连载中',
    language: 'zh-Hans', updatedAt: '2026-11-10', tags: ['冒险'], description: '穿越群星的旅程。',
    files: { text: 'full.txt' }
  }));
  await writeFile(join(book, 'full.txt'), '第一章 出发\n星海在前。');
  return { base, library, output: join(base, 'copy.txt') };
}

function run(fixture, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--library', fixture.library, '--state-dir', join(fixture.base, 'state')], { encoding: 'utf8' });
}

test('search returns matching library entries as readable rows and JSON', async t => {
  const f = await fixture(t);
  const plain = run(f, 'search', '星海');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /sample-book\t星海旅人\t测试作者/);
  const json = run(f, 'search', '测试作者', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).books[0].title, '星海旅人');
});

test('info prints book metadata and reports an unknown id as an error', async t => {
  const f = await fixture(t);
  const result = run(f, 'info', 'sample-book', '--json');
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.wordCount, 9);
  assert.equal(info.chapterCount, 1);
  assert.equal(info.author, '测试作者');
  const plain = run(f, 'info', 'sample-book');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /星海旅人 \(sample-book\)/);
  assert.match(plain.stdout, /简介：穿越群星的旅程。/);
  const missing = run(f, 'info', 'unknown-book');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /找不到这本书/);
});

test('download copies the original full text and refuses to overwrite unless forced', async t => {
  const f = await fixture(t);
  const first = run(f, 'download', 'sample-book', '--output', f.output);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readFile(f.output, 'utf8'), '第一章 出发\n星海在前。');
  await writeFile(f.output, '已存在的文件');
  const second = run(f, 'download', 'sample-book', '--output', f.output);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /输出文件已存在/);
  assert.equal(await readFile(f.output, 'utf8'), '已存在的文件');
  const forced = run(f, 'download', 'sample-book', '--output', f.output, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(await readFile(f.output, 'utf8'), '第一章 出发\n星海在前。');
  assert.ok((await readdir(f.base)).every(name => !name.endsWith('.part')));
});

test('help uses the registered command name and invalid requests fail without a download', async t => {
  const f = await fixture(t);
  const help = run(f, '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /nikowenku-archive <command>/);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['nikowenku-archive'], './scripts/cli.mjs');
  for (const args of [['typo'], ['search'], ['search', '星', '--limit', '0'], ['info'], ['download', 'unknown-book', '--output', f.output]]) {
    const result = run(f, ...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(result.stderr.trim());
  }
  assert.ok(!(await readdir(f.base)).includes('copy.txt'));
});

test('download preserves the source and defaults to the current working directory', async t => {
  const f = await fixture(t);
  const original = join(f.library, 'sample-book', 'full.txt');
  const overwrite = run(f, 'download', 'sample-book', '--output', original, '--force');
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /原始正文/);
  assert.equal(await readFile(original, 'utf8'), '第一章 出发\n星海在前。');
  const result = spawnSync(process.execPath, [cli, 'download', 'sample-book', '--json'], {
    cwd: f.base, encoding: 'utf8', env: { ...process.env, ARCHIVE_LIBRARY: f.library, ARCHIVE_STATE_DIR: join(f.base, 'state') }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).output, join(f.base, 'sample-book.txt'));
  assert.equal(await readFile(join(f.base, 'sample-book.txt'), 'utf8'), await readFile(original, 'utf8'));
});

test('the packaged CLI searches the public API and downloads a remote book', async t => {
  const f = await fixture(t);
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/library?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ total: 1, books: [{ id: 'sample-book', title: '星海旅人', author: '测试作者' }] }));
      return;
    }
    if (request.url === '/api/books/sample-book') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'sample-book', title: '星海旅人', author: '测试作者', category: '奇幻', status: '连载中', language: 'zh-Hans', chapterCount: 1, wordCount: 9, tags: [], description: '', chapters: [], files: [{ kind: 'text', bytes: 8 }] }));
      return;
    }
    if (request.url === '/api/books/sample-book/files/text') {
      response.setHeader('Content-Disposition', "attachment; filename*=UTF-8''sample-book.txt");
      response.end('远端完整正文');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: '找不到这本书' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const site = `http://127.0.0.1:${server.address().port}`;
  const runRemote = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--site', site], { cwd: f.base });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });

  const search = await runRemote('search', '星海', '--json');
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).books[0].id, 'sample-book');
  const info = await runRemote('info', 'sample-book', '--json');
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).title, '星海旅人');
  const download = await runRemote('download', 'sample-book');
  assert.equal(download.status, 0, download.stderr);
  assert.equal(await readFile(join(f.base, 'sample-book.txt'), 'utf8'), '远端完整正文');
  const duplicate = await runRemote('download', 'sample-book');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /输出文件已存在/);
});
