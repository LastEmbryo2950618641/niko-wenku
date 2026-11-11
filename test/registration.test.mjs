import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createAppServer } from '../server/app.mjs';
import { createCaptchaService } from '../server/captcha.mjs';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'archive-registration-'));
  const webRoot = join(root, 'web'), adminAuthFile = join(root, 'admin.json');
  await mkdir(webRoot);
  const salt = randomBytes(16).toString('hex');
  await writeFile(adminAuthFile, JSON.stringify({ version: 1, username: 'owner', salt, passwordHash: scryptSync('test-owner-password', salt, 64).toString('hex') }));
  const server = await createAppServer({ libraryRoot: join(root, 'library'), webRoot, adminAuthFile, captchaService: createCaptchaService({ makeAnswer: () => '12345' }), ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body = {}, overrides = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: origin, ...overrides }, body: JSON.stringify(body) });
  async function issue(purpose) {
    const response = await fetch(origin + '/api/auth/captcha?purpose=' + purpose);
    return { challenge: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  return { root, origin, post, issue, adminAuthFile };
}

test('public registration advertises availability and requires a server-verified captcha', async t => {
  const f = await fixture(t);
  const session = await (await fetch(f.origin + '/api/auth/session')).json();
  assert.equal(session.registrationEnabled, true);
  const missing = await f.post('/api/auth/register', { username: 'reader', password: 'reader-password', role: 'admin' });
  assert.equal(missing.status, 400);
  assert.equal((await fetch(f.origin + '/api/worker/status')).status, 401);
  const { challenge, cookie } = await f.issue('register');
  const created = await f.post('/api/auth/register', { username: 'reader', password: 'reader-password', captchaId: challenge.id, captcha: '12345', role: 'admin' }, { Cookie: cookie });
  assert.equal(created.status, 201);
  const sessionCookie = created.headers.get('set-cookie');
  assert.match(sessionCookie, /HttpOnly/);
  assert.equal((await created.json()).role, 'reader');
  assert.equal((await fetch(f.origin + '/api/worker/status', { headers: { Cookie: sessionCookie.split(';')[0] } })).status, 403);
});

test('captcha issuance returns an image without its solution and rejects unrelated purposes', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/auth/captcha?purpose=register');
  assert.equal(response.status, 200);
  const challenge = await response.json();
  assert.match(challenge.id, /^[a-f0-9]{48}$/);
  assert.match(challenge.imageUrl, /^\/api\/auth\/captcha\/[a-f0-9]{48}\.png$/);
  assert.ok(challenge.expiresAt);
  assert.equal(challenge.answer, undefined);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(f.origin + '/api/auth/captcha?purpose=anything')).status, 400);
  const image = await fetch(f.origin + challenge.imageUrl, { headers: { Cookie: response.headers.get('set-cookie').split(';')[0] } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('captcha attempts are one-use, bound to their browser and purpose, and expire', async () => {
  let now = 1000;
  const service = createCaptchaService({ makeAnswer: () => '12345', now: () => now });
  const req = { headers: {} }, headers = {};
  const res = { setHeader(name, value) { headers[name] = value; } };
  function issue(purpose = 'register') {
    const challenge = service.issue(req, res, purpose, false);
    if (headers['Set-Cookie']) req.headers.cookie = headers['Set-Cookie'].split(';')[0];
    return { captchaId: challenge.id, captcha: '12345' };
  }
  let payload = issue();
  assert.throws(() => service.verify({ headers: {} }, payload, 'register'), /验证码/);
  service.verify(req, payload, 'register');
  assert.throws(() => service.verify(req, payload, 'register'), /验证码/);
  payload = issue();
  assert.throws(() => service.verify(req, payload, 'login'), /验证码/);
  assert.throws(() => service.verify(req, payload, 'register'), /验证码/);
  payload = issue();
  assert.throws(() => service.verify(req, { ...payload, captcha: '错误答案啊' }, 'register'), /验证码/);
  assert.throws(() => service.verify(req, payload, 'register'), /验证码/);
  payload = issue();
  now += 5 * 60 * 1000;
  assert.throws(() => service.verify(req, payload, 'register'), /验证码/);
});

test('reader accounts persist as hashes, reject duplicates and cannot choose their role', async t => {
  const f = await fixture(t);
  async function attempt(fixture, purpose, username) {
    const { challenge, cookie } = await fixture.issue(purpose);
    return fixture.post('/api/auth/' + purpose, { username, password: 'a-reader-password', captchaId: challenge.id, captcha: '12345', role: 'admin' }, { Cookie: cookie });
  }
  const attempts = await Promise.all([attempt(f, 'register', 'Reader'), attempt(f, 'register', 'Reader')]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
  const raw = await readFile(join(f.root, 'users.json'), 'utf8');
  assert.doesNotMatch(raw, /a-reader-password/);
  const users = JSON.parse(raw);
  assert.equal(users.length, 1);
  assert.match(users[0].passwordHash, /^[a-f0-9]{128}$/);
  assert.equal((await attempt(f, 'register', 'OWNER')).status, 409);
  const restarted = await fixture(t, { adminAuthFile: f.adminAuthFile });
  const login = await attempt(restarted, 'login', 'Reader');
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.role, 'reader');
  assert.equal(session.canManage, false);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await restarted.post('/api/publish', {}, { Cookie: cookie })).status, 403);
});
