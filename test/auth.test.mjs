import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, scryptSync } from 'node:crypto';
import { createAppServer } from '../server/app.mjs';
import { request } from 'node:http';

function withHost(origin, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method: body ? 'POST' : 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'archive-auth-'));
  const libraryRoot = join(root, 'library'), webRoot = join(root, 'dist');
  await mkdir(join(libraryRoot, 'original'), { recursive: true });
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html>public library</html>');
  await writeFile(join(libraryRoot, 'original', 'book.json'), JSON.stringify({ id: 'original', title: '原创测试', files: { text: 'content.txt' } }));
  await writeFile(join(libraryRoot, 'original', 'content.txt'), '第一章 开始\n这是一份原创测试正文。');
  const salt = randomBytes(16).toString('hex');
  const adminAuthFile = join(root, 'admin.json');
  await writeFile(adminAuthFile, JSON.stringify({ version: 1, username: 'owner', salt, passwordHash: scryptSync('a-test-password-only', salt, 64).toString('hex') }));
  const server = await createAppServer({ libraryRoot, webRoot, adminAuthFile, publicOrigin: 'http://archive.example', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body = {}, extra = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', ...extra }, body: JSON.stringify(body) });
  return { root, origin, post };
}

test('public books remain readable while every administration API requires a session', async t => {
  const f = await fixture(t);
  const catalog = await (await fetch(f.origin + '/api/library')).json();
  assert.equal(catalog.books.length, 1);
  assert.equal(catalog.libraryPath, 'library/');
  assert.equal((await fetch(f.origin + '/api/books/original')).status, 200);
  assert.match(await (await fetch(f.origin + '/api/books/original/files/text')).text(), /原创测试正文/);
  for (const path of ['/api/worker/status', '/api/worker/start', '/api/worker/stop', '/api/publish']) {
    const response = path.endsWith('status') ? await fetch(f.origin + path) : await f.post(path);
    assert.equal(response.status, 401, path);
  }
  const session = await (await fetch(f.origin + '/api/auth/session')).json();
  assert.deepEqual(session, { enabled: true, authenticated: false, username: null, public: true });
});

test('username and password create a protected session that logout revokes', async t => {
  const f = await fixture(t);
  const wrong = await f.post('/api/auth/login', { username: 'owner', password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  const response = await f.post('/api/auth/login', { username: 'owner', password: 'a-test-password-only' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, /a-test-password-only|owner/);
  const headers = { Cookie: cookie.split(';')[0] };
  const session = await (await fetch(f.origin + '/api/auth/session', { headers })).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.username, 'owner');
  assert.equal((await fetch(f.origin + '/api/worker/status', { headers })).status, 200);
  assert.equal((await f.post('/api/auth/logout', {}, headers)).status, 200);
  assert.equal((await fetch(f.origin + '/api/worker/status', { headers })).status, 401);
  assert.equal((await fetch(f.origin + '/api/library', { headers })).status, 200);
});

test('login rejects cross-origin and oversized input; unconfigured public access fails closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/auth/login', { username: 'owner', password: 'a-test-password-only' }, { Origin: 'http://unrelated.example' })).status, 403);
  assert.equal((await f.post('/api/auth/login', { username: 'owner', password: 'x'.repeat(9000) })).status, 413);
  const forged = await fetch(f.origin + '/api/worker/status', { headers: { Cookie: 'archive_admin=forged', Authorization: 'Basic anything' } });
  assert.equal(forged.status, 401);
  await assert.rejects(createAppServer({ libraryRoot: join(f.root, 'empty'), webRoot: f.root, publicOrigin: 'http://archive.example' }), /管理|登录|auth/i);
});

test('public host is explicitly allowlisted and HTTPS sessions carry Secure cookies', async t => {
  const f = await fixture(t, { publicOrigin: 'https://archive.example' });
  assert.equal((await withHost(f.origin, '/api/health', { Host: 'archive.example' })).status, 200);
  assert.equal((await withHost(f.origin, '/api/health', { Host: 'unrelated.example' })).status, 403);
  const response = await withHost(f.origin, '/api/auth/login', { Host: 'archive.example', Origin: 'https://archive.example', 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, JSON.stringify({ username: 'owner', password: 'a-test-password-only' }));
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /; Secure/i);
});

test('repeated failed logins are throttled without leaking credentials', async t => {
  const f = await fixture(t);
  let response;
  for (let i = 0; i < 10; i++) response = await f.post('/api/auth/login', { username: 'nonexistent', password: 'bad' });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.doesNotMatch(await response.text(), /passwordHash|a-test-password-only|salt/);
});

test('parallel login attempts cannot bypass the login attempt limit', async t => {
  const f = await fixture(t);
  const attempts = await Promise.all(Array.from({ length: 12 }, () => f.post('/api/auth/login', { username: 'owner', password: 'wrong-password' })));
  assert.ok(attempts.filter(response => response.status === 429).length >= 4);
});
