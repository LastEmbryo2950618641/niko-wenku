import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCiweimaoCookieStore } from '../server/ciweimao-auth.mjs';
import { createCiweimaoClient } from '../server/ciweimao.mjs';
import { createCiweimaoController } from '../server/ciweimao-control.mjs';

const listHtml = page => `<table class="book-list-table"><tr><td class="name"><a href="https://www.ciweimao.com/book/100">测试书</a></td></tr></table><input id="curr_page" value="${page}"><ul class="pagination"><li class="pageSkip"><i>100</i></li></ul><script>if (page>=20 && !HB.util.Cookie.get('booklistCode')) { return; }</script>`;

test('imported verification cookies allow the requested list page to reach the server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-gate-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createCiweimaoCookieStore(file);
  await store.import({ cookieHeader: 'session=private; booklistCode=verified' });
  const seen = [];
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, cookieFile: file, fetchImpl: async (url, options) => {
    seen.push({ page: Number(url.pathname.split('/').pop()), cookie: options.headers.Cookie });
    return new Response(listHtml(seen.at(-1).page));
  } });
  t.after(() => client.close());
  assert.equal((await client.discover(20)).page, 20);
  assert.deepEqual(seen.map(item => item.page), [1, 20]);
  assert.ok(seen.every(item => item.cookie.includes('booklistCode=verified')));
  await store.clear();
  await assert.rejects(client.discover(21), error => error.code === 'ACCESS');
  assert.equal(seen.length, 2);
});

test('verification cookies with the wrong path, expired cookies or empty values cannot pass the list gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-invalid-gate-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const cookie of [{ path: '/book' }, { expires: 1 }, { value: '' }, { domain: 'wap.ciweimao.com' }]) {
    const store = await createCiweimaoCookieStore(file);
    await store.import({ cookies: [{ name: 'session', value: 'present', domain: '.ciweimao.com' }, { name: 'booklistCode', value: 'verified', domain: '.ciweimao.com', ...cookie }] });
    let requests = 0;
    const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, cookieFile: file, fetchImpl: async () => { requests++; return new Response(listHtml(1)); } });
    try { await assert.rejects(client.discover(20), error => error.code === 'ACCESS'); assert.equal(requests, 1); }
    finally { await client.close(); }
  }
});

test('auth checks verify the real saved scan page without starting workers or exposing source errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-check-')), stateDir = join(root, 'state'), nested = join(stateDir, 'ciweimao');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(nested, { recursive: true });
  const checkpoint = JSON.stringify({ status: 'access_required', scan: { nextPage: 24 } });
  await writeFile(join(nested, 'worker-state.json'), checkpoint);
  let requests = 0, closed = 0, fail = '';
  const control = createCiweimaoController({ stateDir, libraryRoot: join(root, 'library'), createClient: async () => ({
    async discover(page) { requests++; assert.equal(page, 24); if (fail) throw Object.assign(new Error('private cookie value'), { code: fail }); return { page }; },
    async close() { closed++; }
  }) });
  assert.equal((await control.checkAuth()).verification.status, 'missing');
  assert.equal(requests, 0);
  await control.importAuth({ cookieHeader: 'session=private; booklistCode=secret' });
  assert.equal((await control.checkAuth()).verification.status, 'usable');
  fail = 'ACCESS';
  const rejected = await control.checkAuth();
  assert.equal(rejected.verification.status, 'access_required');
  assert.doesNotMatch(JSON.stringify(rejected), /private|secret/);
  fail = 'NETWORK';
  assert.equal((await control.checkAuth()).verification.status, 'network_error');
  assert.equal(closed, 3);
  assert.equal(await readFile(join(nested, 'worker-state.json'), 'utf8'), checkpoint);
});

test('expired cookies are excluded immediately and corrupted stores fail closed on refresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-expired-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createCiweimaoCookieStore(file);
  const status = await store.import({ cookies: [
    { name: 'old', value: 'expired', expires: 1 }, { name: 'zero', value: 'expired', expires: 0 }, { name: 'current', value: 'valid' }
  ] });
  assert.equal(status.count, 1);
  assert.equal(store.header('www.ciweimao.com'), 'current=valid');
  await writeFile(file, '{broken');
  await store.refresh();
  assert.equal(store.header('www.ciweimao.com'), '');
  assert.equal(store.status().configured, false);
});

test('a saved verification cookie never turns an upstream rejection into a successful check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-rejected-')), stateDir = join(root, 'state');
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = createCiweimaoController({ stateDir, libraryRoot: join(root, 'library'), createClient: options => createCiweimaoClient({ ...options, proxy: 'direct', delayMs: 0, fetchImpl: async url => {
    const page = Number(url.pathname.split('/').pop());
    return page === 1 ? new Response(listHtml(1)) : new Response('verification required', { status: 403 });
  } }) });
  await control.importAuth({ cookieHeader: 'booklistCode=private' });
  const result = await control.checkAuth();
  assert.equal(result.verification.status, 'access_required');
  assert.equal(result.verification.page, 20);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('login cookies without a list verification cookie report the precise missing verification step', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-login-only-')), stateDir = join(root, 'state');
  t.after(() => rm(root, { recursive: true, force: true }));
  const pages = [];
  const control = createCiweimaoController({ stateDir, libraryRoot: join(root, 'library'), createClient: options => createCiweimaoClient({ ...options, proxy: 'direct', delayMs: 0, fetchImpl: async url => {
    const page = Number(url.pathname.split('/').pop()); pages.push(page);
    return new Response(listHtml(page));
  } }) });
  await control.importAuth({ cookieHeader: 'login_token=private; ci_session=private' });
  const result = await control.checkAuth();
  assert.equal(result.configured, true);
  assert.equal(result.verification.status, 'access_required');
  assert.equal(result.verification.reason, 'list_verification_missing');
  assert.equal(result.verification.page, 20);
  assert.match(result.verification.message, /booklistCode/);
  assert.deepEqual(pages, [1]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('checking availability leaves running workers alone and rejects overlapping checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-busy-')), stateDir = join(root, 'state'), nested = join(stateDir, 'ciweimao');
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0, release;
  const control = createCiweimaoController({ stateDir, libraryRoot: join(root, 'library'), createClient: async () => ({
    async discover(page) { requests++; await new Promise(done => { release = done; }); return { page }; }, async close() {}
  }) });
  await control.importAuth({ cookieHeader: 'session=private' });
  await writeFile(join(nested, 'worker.lock'), JSON.stringify({ pid: process.pid }));
  assert.equal((await control.checkAuth()).verification.status, 'busy');
  assert.equal(requests, 0);
  await rm(join(nested, 'worker.lock'));
  const pending = control.checkAuth();
  try {
    for (let i = 0; i < 100 && !release; i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(typeof release, 'function');
    await assert.rejects(control.checkAuth(), error => error.status === 429);
  } finally { release?.(); await pending; }
});

test('ciweimao cookie store imports browser exports, scopes domains and persists without exposing values in status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-auth-')), file = join(root, 'ciweimao', 'auth.json');
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const store = await createCiweimaoCookieStore(file);
  const status = await store.import({ cookieHeader: 'Cookie: session=secret; booklistCode=verified' });
  assert.equal(status.configured, true); assert.equal(status.count, 2); assert.deepEqual(status.domains, ['ciweimao.com']);
  assert.match(store.header('www.ciweimao.com'), /session=secret/);
  assert.match(store.header('wap.ciweimao.com'), /booklistCode=verified/);
  assert.doesNotMatch(JSON.stringify(status), /secret|verified/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.version, 1); assert.equal(persisted.cookies.length, 2);
  await assert.rejects(store.import({ cookies: [{ name: 'session', value: 'x', domain: 'evil.example' }] }), /域名/);
});

test('expired cookies stay expired across reloads and cookies only reach their declared paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-scope-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createCiweimaoCookieStore(file);
  await store.import({ cookies: [
    { name: 'expired', value: 'obsolete', domain: '.ciweimao.com', expires: 1 },
    { name: 'catalog', value: 'allowed', domain: 'www.ciweimao.com', path: '/book' },
    { name: 'session', value: 'active', domain: '.ciweimao.com', expires: -1 }
  ] });
  const reloaded = await createCiweimaoCookieStore(file);
  assert.equal(reloaded.header('www.ciweimao.com', '/book/100'), 'catalog=allowed; session=active');
  assert.equal(reloaded.header('www.ciweimao.com', '/booklist'), 'session=active');
  assert.equal(reloaded.header('wap.ciweimao.com', '/book/100'), 'session=active');
  assert.equal(reloaded.status().count, 2);
});

test('Set-Cookie preserves domain and path and honours deletion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-set-cookie-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createCiweimaoCookieStore(file);
  await store.setFromHeader('www.ciweimao.com', 'login=fresh; Domain=.ciweimao.com; Path=/book; Secure');
  assert.equal(store.header('wap.ciweimao.com', '/book/100'), 'login=fresh');
  assert.equal(store.header('www.ciweimao.com', '/'), '');
  await store.setFromHeader('www.ciweimao.com', 'login=; Domain=.ciweimao.com; Path=/book; Max-Age=0');
  assert.equal((await createCiweimaoCookieStore(file)).status().configured, false);
});

test('clearing saved auth also clears the next request from a running client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-clear-')), file = join(root, 'auth.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createCiweimaoCookieStore(file);
  await store.import({ cookieHeader: 'session=initial' });
  const seen = [];
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, cookieFile: file, fetchImpl: async (_url, options) => {
    seen.push(options.headers.Cookie || '');
    return new Response('<div class="rank-book-list"></div>', { headers: seen.length === 1 ? { 'set-cookie': 'fresh=old; Path=/' } : {} });
  } });
  t.after(() => client.close());
  await client.search('测试');
  await store.clear();
  await client.search('测试');
  assert.equal(seen[1], '');
  await store.import({ cookieHeader: 'session=replaced' });
  await client.search('测试');
  assert.equal(seen[2], 'session=replaced');
});

test('ciweimao client loads persisted cookies and persists allowed Set-Cookie updates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-client-auth-')), file = join(root, 'auth.json');
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const store = await createCiweimaoCookieStore(file);
  await store.import({ cookieHeader: 'session=secret' });
  let seen = '';
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, cookieFile: file, fetchImpl: async (_url, options) => {
    seen = options.headers.Cookie || '';
    return new Response('<div class="rank-book-list"></div>', { headers: { 'set-cookie': 'fresh=updated; Path=/; Secure' } });
  } });
  t.after(() => client.close());
  await client.search('测试');
  assert.match(seen, /session=secret/);
  const next = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(next.cookies.some(cookie => cookie.name === 'fresh'));
  assert.doesNotMatch(JSON.stringify(await (await createCiweimaoCookieStore(file)).status()), /secret|=updated/);
});
