import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server/app.mjs';

test('read-only public server serves books without auth or worker and confines its index to separate state', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-api-'));
  const libraryRoot = join(base, 'library');
  const stateDir = join(base, 'read-state');
  const bookDir = join(libraryRoot, 'book');
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, 'book.json'), JSON.stringify({ id: 'book', title: '只读测试', files: { text: 'content.txt' } }));
  await writeFile(join(bookDir, 'content.txt'), '第一章\n内容');

  const server = await createAppServer({ libraryRoot, stateDir, readOnly: true, publicOrigin: 'http://127.0.0.1', adminAuthFile: join(base, 'does-not-exist-auth.json'), worker: { stateDir: join(base, 'worker-state'), queuePath: join(base, 'queue.json') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });

  const origin = 'http://127.0.0.1:' + server.address().port;
  const healthResponse = await fetch(origin + '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, name: '文库档案', readOnly: true });
  assert.equal((await (await fetch(origin + '/api/library')).json()).total, 1);
  assert.equal((await (await fetch(origin + '/api/books/book')).json()).title, '只读测试');
  assert.equal(await (await fetch(origin + '/api/books/book/files/text')).text(), '第一章\n内容');
  assert.equal((await fetch(origin + '/api/books/book/files/text', { method: 'HEAD' })).status, 200);

  for (const path of ['/api/publish', '/api/worker/start', '/api/worker/stop', '/api/auth/register', '/api/books/book', '/api/library', '/api/health']) {
    assert.equal((await fetch(origin + path, { method: 'POST' })).status, 405, path);
  }
  for (const path of ['/api/worker/status', '/api/auth/session', '/api/auth/captcha', '/index.html', '/api/books/book/unknown']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin + '/api/library', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(origin + '/api/books/missing')).status, 404);
  assert.deepEqual(await readdir(stateDir), ['library-index.json']);
  assert.deepEqual(await readdir(libraryRoot), ['book']);
  assert.match(await readFile(join(stateDir, 'library-index.json'), 'utf8'), /只读测试/);
  assert.deepEqual((await readdir(base)).sort(), ['library', 'read-state']);
  await rm(libraryRoot, { recursive: true });
  assert.equal((await fetch(origin + '/api/health')).status, 503);
});

test('read-only public server rejects other public hosts', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-host-'));
  await mkdir(join(base, 'library'));
  const server = await createAppServer({ libraryRoot: join(base, 'library'), stateDir: join(base, 'state'), readOnly: true, publicOrigin: 'http://books.example.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { Host: 'attacker.example.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('read-only server requires existing library and explicit state outside the library', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const libraryRoot = join(base, 'library');
  await mkdir(libraryRoot);
  for (const stateDir of [undefined, libraryRoot, join(libraryRoot, '.state')]) {
    await assert.rejects(createAppServer({ libraryRoot, stateDir, readOnly: true }), /独立.*状态目录/);
  }
  await assert.rejects(createAppServer({ libraryRoot: join(base, 'missing'), stateDir: join(base, 'state'), readOnly: true }), /书库/);
  assert.deepEqual(await readdir(libraryRoot), []);
});

test('standalone read API rejects incomplete configuration', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-entry-'));
  const libraryRoot = join(base, 'library');
  await mkdir(libraryRoot);
  t.after(() => rm(base, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../server/read-api.mjs', import.meta.url));
  const env = { ...process.env, ARCHIVE_LIBRARY: '', ARCHIVE_READ_STATE_DIR: '', ARCHIVE_READ_PORT: '' };
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', data => { error += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.notEqual(code, 0);
  assert.match(error, /ARCHIVE_LIBRARY/);
});

test('read-only state cannot create directories inside the library through a symlink', async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-link-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const libraryRoot = join(base, 'library');
  const alias = join(base, 'library-alias');
  await mkdir(libraryRoot);
  await symlink(libraryRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createAppServer({ libraryRoot, stateDir: join(alias, 'nested-state'), readOnly: true }), /独立.*状态目录/);
  assert.deepEqual(await readdir(libraryRoot), []);
});

test('isolated standalone read API needs no npm dependencies and only serves read requests', { timeout: 15000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'wenku-read-isolated-'));
  await mkdir(join(base, 'library'));
  for (const name of ['server/app.mjs', 'server/read-api.mjs', 'server/library.mjs', 'server/text.mjs', 'server/captcha.mjs', 'shared/language.mjs']) {
    const dest = join(base, name);
    await mkdir(join(dest, '..'), { recursive: true });
    await cp(new URL('../' + name, import.meta.url), dest);
  }
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [join(base, 'server/read-api.mjs'), '--library', join(base, 'library'), '--state-dir', join(base, 'state'), '--port', String(port)], { cwd: base, signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
    await rm(base, { recursive: true, force: true });
  });
  let output = '', error = '';
  child.stderr.on('data', data => { error += data; });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.once('exit', code => reject(new Error('Startup failed: ' + code + ' ' + error)));
    child.stdout.on('data', data => { output += data; if (output.includes('http://127.0.0.1:' + port)) resolve(); });
  });
  const origin = 'http://127.0.0.1:' + port;
  assert.equal((await (await fetch(origin + '/api/health')).json()).readOnly, true);
  assert.equal((await fetch(origin + '/api/worker/start', { method: 'POST' })).status, 405);
  assert.equal((await fetch(origin + '/api/auth/session')).status, 404);
});
