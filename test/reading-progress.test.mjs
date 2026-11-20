import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createAppServer } from '../server/app.mjs';
import { createCaptchaService } from '../server/captcha.mjs';
import { createReadingProgress } from '../server/reading-progress.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'archive-reading-'));
  const webRoot = join(root, 'web');
  const adminAuthFile = join(root, 'admin.json');
  await mkdir(webRoot);
  const salt = randomBytes(16).toString('hex');
  await writeFile(adminAuthFile, JSON.stringify({ version: 1, username: 'owner', salt, passwordHash: scryptSync('test-owner-password', salt, 64).toString('hex') }));
  const server = await createAppServer({ libraryRoot: join(root, 'library'), webRoot, adminAuthFile, stateDir: join(root, 'state'), captchaService: createCaptchaService({ makeAnswer: () => '12345' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function login(username, password) {
    const captcha = await fetch(origin + '/api/auth/captcha?purpose=login');
    const challenge = await captcha.json();
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: origin, Cookie: captcha.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ username, password, captchaId: challenge.id, captcha: '12345' }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const post = (cookie, body, headers = {}) => fetch(origin + '/api/reading-progress', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: origin, Cookie: cookie, ...headers }, body: JSON.stringify(body) });
  return { origin, login, post };
}

test('reading progress is stored per account and restored after a new session', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/api/reading-progress')).status, 401);
  const owner = await f.login('owner', 'test-owner-password');
  const saved = await f.post(owner, { bookId: 'wenku8-4533', chapter: 4, title: '第四章', scroll: 820, visitedAt: 1_700_000_000_000 });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).progress['wenku8-4533'], { chapter: 4, title: '第四章', scroll: 820, visitedAt: 1_700_000_000_000 });
  const listed = await (await fetch(f.origin + '/api/reading-progress', { headers: { Cookie: owner } })).json();
  assert.equal(listed.progress['wenku8-4533'].chapter, 4);
  const again = await f.login('owner', 'test-owner-password');
  const restored = await (await fetch(f.origin + '/api/reading-progress', { headers: { Cookie: again } })).json();
  assert.equal(restored.progress['wenku8-4533'].scroll, 820);
  const rejected = await f.post(owner, { bookId: '../secrets', chapter: 0, title: '', scroll: 0 });
  assert.equal(rejected.status, 400);
  const crossOrigin = await f.post(owner, { bookId: 'wenku8-1', chapter: 0, title: '开篇', scroll: 0 }, { Origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403);
});

test('one account cannot read another account progress', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner', 'test-owner-password');
  assert.equal((await f.post(owner, { bookId: 'book-a', chapter: 1, title: '甲', scroll: 10, visitedAt: 50 })).status, 200);
  const captcha = await fetch(f.origin + '/api/auth/captcha?purpose=register');
  const challenge = await captcha.json();
  const created = await fetch(f.origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: f.origin, Cookie: captcha.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ username: 'reader', password: 'reader-password', captchaId: challenge.id, captcha: '12345' }) });
  assert.equal(created.status, 201);
  const reader = created.headers.get('set-cookie').split(';')[0];
  const hidden = await (await fetch(f.origin + '/api/reading-progress', { headers: { Cookie: reader } })).json();
  assert.equal(hidden.progress['book-a'], undefined);
  assert.equal((await f.post(reader, { bookId: 'book-b', chapter: 2, title: '乙', scroll: 0, visitedAt: 80 })).status, 200);
  const ownerList = await (await fetch(f.origin + '/api/reading-progress', { headers: { Cookie: owner } })).json();
  assert.equal(ownerList.progress['book-b'], undefined);
  assert.equal(ownerList.progress['book-a'].title, '甲');
  const stale = await f.post(owner, { bookId: 'book-a', chapter: 0, title: '旧', scroll: 1, visitedAt: 10 });
  assert.equal((await stale.json()).progress['book-a'].title, '甲');
});

test('sqlite keeps the newest five hundred positions for one account', async () => {
  const directory = join(tmpdir(), 'archive-reading-limit-' + randomBytes(4).toString('hex'));
  const store = createReadingProgress(directory);
  try {
    for (let index = 0; index < 505; index += 1) store.save('owner', { bookId: 'book-' + index, chapter: index, title: '章', scroll: 0, visitedAt: index });
    const progress = store.list('owner');
    assert.equal(Object.keys(progress).length, 500);
    assert.equal(progress['book-0'], undefined);
    assert.equal(progress['book-504'].chapter, 504);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('read-only standby does not expose reading progress', async t => {
  const root = await mkdtemp(join(tmpdir(), 'archive-reading-readonly-'));
  const libraryRoot = join(root, 'library');
  await mkdir(libraryRoot);
  const server = await createAppServer({ libraryRoot, stateDir: join(root, 'state'), readOnly: true, publicOrigin: 'http://127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  assert.equal((await fetch('http://127.0.0.1:' + server.address().port + '/api/reading-progress')).status, 404);
});
