import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCiweimaoCookieStore } from '../server/ciweimao-auth.mjs';
import { createCiweimaoClient } from '../server/ciweimao.mjs';

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
