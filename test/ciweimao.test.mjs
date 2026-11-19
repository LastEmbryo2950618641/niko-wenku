import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ciweimaoId, parseCiweimaoBookList, parseCiweimaoCatalog, parseCiweimaoSearch, decodeCiweimaoContent, cleanCiweimaoContent, createCiweimaoClient } from '../server/ciweimao.mjs';
import { syncCiweimaoBook, runCiweimaoWorker } from '../server/ciweimao-worker.mjs';
import { createAppServer } from '../server/app.mjs';
import { createLibrary } from '../server/library.mjs';
import { createCaptchaService } from '../server/captcha.mjs';
import { randomBytes, scryptSync } from 'node:crypto';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-'));
  const libraryRoot = join(root, 'library'), stateDir = join(root, 'state');
  await mkdir(stateDir); await mkdir(libraryRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, libraryRoot, stateDir };
}
function source() {
  const book = { id: '100', title: '原创测试作品', author: '作者', description: '原创测试', status: '连载中（免费章节）', url: 'https://www.ciweimao.com/book/100', chapters: [
    { id: '11', index: 1, title: '开端', free: true }, { id: '12', index: 2, title: '收费章节', free: false }, { id: '13', index: 3, title: '番外', free: true }
  ] };
  const requests = [];
  return { book, requests, async catalog() { return book; }, async content(_, chapter) { requests.push(chapter.id); return '原创正文 ' + chapter.id; }, async close() {} };
}

test('ciweimao parser keeps free chapters after paid chapters and decodes the Skill test vector', () => {
  const html = '<div class="book-info"><h1 class="book">书名</h1><p class="author">作者 著 / 分类</p></div><div class="catalogue"><h2>卷一</h2><ul class="catalogue-list"><li><a href="/chapter/11">开端</a></li><li><a href="/chapter/12"><i class="icon-lock"></i>收费</a></li><li><a href="/chapter/13">番外</a></li></ul></div>';
  assert.deepEqual(parseCiweimaoCatalog(html, '100').chapters.map(chapter => chapter.free), [true, false, true]);
  const ciphertext = 'QUFBQUFBQUFBQUFBQUFBQUpItDAn1k/+Uxdfchw5FRcTOFAtKSEai4vy1kHTnyG6DZNi6Uk6GsYVg4CLelkPBwiZoj+DWno81DvsWPIdj0tMkeekf3hMJCmNRbwfXMchbkiCWSQhyfbyTVW9aKXZ0KBFY14iJbQBfbvs4HVOyjo=';
  assert.equal(cleanCiweimaoContent(decodeCiweimaoContent(ciphertext, ['MDEyMzQ1Njc4OWFiY2RlZg==', 'YWJjZGVmMDEyMzQ1Njc4OQ==', 'ZmVkY2JhOTg3NjU0MzIxMA=='], 'Ay')), '测试正文');
  assert.equal(ciweimaoId('https://www.ciweimao.com/book/100'), '100');
  assert.throws(() => ciweimaoId('https://example.org/book/100'));
  assert.throws(() => cleanCiweimaoContent('<html>请登录</html>'));
  assert.deepEqual(parseCiweimaoSearch('<div class="rank-book-list"></div>'), []);
});

test('paid chapters make no request and access restrictions stop the client', async () => {
  let requests = 0;
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, fetchImpl: async () => { requests++; return new Response('denied', { status: 429 }); } });
  try {
    await assert.rejects(client.content('100', { id: '11', free: false }), error => error.code === 'PAID');
    assert.equal(requests, 0);
    await assert.rejects(client.catalog('100'), error => error.code === 'ACCESS');
    assert.equal(requests, 1);
  } finally { await client.close(); }
});

test('sync publishes only free content in its category, resumes by hash and repairs damaged files', async t => {
  const f = await fixture(t), client = source();
  await syncCiweimaoBook({ ...f, id: '100', client });
  assert.deepEqual(client.requests, ['11', '13']);
  const path = join(f.libraryRoot, 'ciweimao-100');
  const metadata = JSON.parse(await readFile(join(path, 'book.json'), 'utf8'));
  assert.equal(metadata.category, '刺猬猫免费章节');
  assert.equal(metadata.source.freeChapterCount, 2);
  assert.equal(metadata.source.skippedChapterCount, 1);
  const library = createLibrary(f.libraryRoot);
  const catalog = await library.scan();
  assert.equal(catalog.books[0].chapterCount, 2);
  assert.doesNotMatch(await readFile(join(path, 'content.txt'), 'utf8'), /收费章节/);
  client.requests.length = 0;
  assert.equal((await syncCiweimaoBook({ ...f, id: '100', client })).unchanged, true);
  assert.deepEqual(client.requests, []);
  await writeFile(join(f.stateDir, 'cache/100/11.txt'), 'corrupt');
  await syncCiweimaoBook({ ...f, id: '100', client });
  assert.deepEqual(client.requests, ['11']);
  await writeFile(join(path, 'content.txt'), 'corrupt published text');
  assert.equal((await syncCiweimaoBook({ ...f, id: '100', client })).unchanged, false);
  assert.match(await readFile(join(path, 'content.txt'), 'utf8'), /原创正文/);
});

test('failed updates preserve the published book; retry adds new chapters without refetching saved chapters', async t => {
  const f = await fixture(t), client = source();
  await syncCiweimaoBook({ ...f, id: '100', client });
  const path = join(f.libraryRoot, 'ciweimao-100/content.txt'), old = await readFile(path);
  client.book.chapters.push({ id: '14', index: 4, title: '更新章节', free: true });
  const content = client.content;
  client.content = async () => { throw new Error('offline'); };
  await assert.rejects(syncCiweimaoBook({ ...f, id: '100', client }), /offline/);
  assert.deepEqual(await readFile(path), old);
  client.content = content; client.requests.length = 0;
  await syncCiweimaoBook({ ...f, id: '100', client });
  assert.deepEqual(client.requests, ['14']);
  assert.match(await readFile(path, 'utf8'), /更新章节/);
});

test('each partial cache checkpoint retains valid later chapters even before error cleanup', async t => {
  const f = await fixture(t), client = source();
  await syncCiweimaoBook({ ...f, id: '100', client });
  client.book.chapters[0].title = '改名章节';
  let inspected = false;
  await assert.rejects(syncCiweimaoBook({ ...f, id: '100', client, onProgress: async progress => {
    if (progress.completed !== 1) return;
    const manifest = JSON.parse(await readFile(join(f.stateDir, 'cache/100/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.chapters.map(chapter => chapter.id), ['11', '13']);
    inspected = true; throw new Error('simulate interruption');
  } }), /simulate interruption/);
  assert.equal(inspected, true);
});

test('independent worker stops on site verification and leaves the original worker state intact', async t => {
  const f = await fixture(t), client = source();
  await writeFile(join(f.stateDir, 'queue.json'), JSON.stringify({ version: 1, books: ['100', '200'], autoDiscover: false }));
  const original = join(f.root, 'worker-state.json');
  await writeFile(original, '{"source":"wenku8"}');
  client.catalog = async () => { throw Object.assign(new Error('需要验证'), { code: 'ACCESS' }); };
  await runCiweimaoWorker({ ...f, once: true, createClient: async () => client });
  const state = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
  assert.equal(state.status, 'access_required'); assert.equal(state.running, false);
  assert.equal(state.books['100'].status, 'failed'); assert.equal(state.books['200'].status, 'pending');
  assert.equal(await readFile(original, 'utf8'), '{"source":"wenku8"}');
  await assert.rejects(readFile(join(f.stateDir, 'worker.lock')), { code: 'ENOENT' });
});

test('website API keeps the old queue unchanged and rejects cross-origin controls and custom paths', async t => {
  const f = await fixture(t), queuePath = join(f.root, 'old-queue.json');
  const original = '{"books":[],"paused":true}'; await writeFile(queuePath, original);
  const server = await createAppServer({ libraryRoot: f.libraryRoot, webRoot: f.root, worker: { stateDir: f.stateDir, queuePath } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (action, payload = {}, extra = {}) => fetch(origin + '/api/worker/ciweimao/' + action, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', ...extra }, body: JSON.stringify(payload) });
  assert.equal((await post('add', { bookId: '100' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('add', { bookId: '100', path: '/arbitrary' })).status, 400);
  await mkdir(join(f.stateDir, 'ciweimao'), { recursive: true });
  await writeFile(join(f.stateDir, 'ciweimao/queue.json'), JSON.stringify({ version: 1, books: [], autoDiscover: false }));
  assert.equal((await post('start')).status, 400);
  const added = await post('add', { bookId: 'https://www.ciweimao.com/book/100' });
  assert.equal(added.status, 200); assert.equal((await added.json()).books[0].id, '100');
  await post('add', { bookId: '100' });
  const state = await (await fetch(origin + '/api/worker/ciweimao/status')).json();
  assert.equal(state.queued, 1); assert.doesNotMatch(JSON.stringify(state), /token|libraryRoot|stateDir/);
  assert.equal((await post('remove', { bookId: '100' })).status, 200);
  assert.equal(await readFile(queuePath, 'utf8'), original);
});

test('background process can start and stop independently with an empty queue', { timeout: 20000 }, async t => {
  const f = await fixture(t), script = resolve('scripts/sync-ciweimao.mjs');
  await writeFile(join(f.stateDir, 'queue.json'), JSON.stringify({ version: 1, books: [], autoDiscover: false }));
  const args = [script, '--state-dir', f.stateDir, '--library', f.libraryRoot];
  t.after(() => exec(process.execPath, [...args, '--stop'], { windowsHide: true }).catch(() => {}));
  await exec(process.execPath, [...args, '--background'], { windowsHide: true });
  let state;
  for (let i = 0; i < 50; i++) { try { state = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8')); if (state.status === 'idle') break; } catch {} await delay(50); }
  assert.equal(state.running, true); assert.equal(state.status, 'idle');
  await exec(process.execPath, [...args, '--stop'], { windowsHide: true });
  state = JSON.parse(await readFile(join(f.stateDir, 'worker-state.json'), 'utf8'));
  assert.equal(state.running, false);
});

test('ciweimao endpoints require an administrator session on authenticated instances', async t => {
  const f = await fixture(t), auth = join(f.root, 'auth.json'), salt = randomBytes(16).toString('hex');
  await writeFile(auth, JSON.stringify({ version: 1, username: 'owner', salt, passwordHash: scryptSync('test-password-only', salt, 64).toString('hex') }));
  const server = await createAppServer({ libraryRoot: f.libraryRoot, webRoot: f.root, adminAuthFile: auth,
    worker: { stateDir: f.stateDir, queuePath: join(f.root, 'old-queue.json') }, captchaService: createCaptchaService({ makeAnswer: () => '12345' }) });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, cookie = '') => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin + '/api/worker/ciweimao/status')).status, 401);
  assert.equal((await fetch(origin + '/api/worker/ciweimao/search?q=test')).status, 401);
  assert.equal((await post('/api/worker/ciweimao/add', { bookId: '100' })).status, 401);
  const issued = await fetch(origin + '/api/auth/captcha?purpose=login'), challenge = await issued.json();
  const login = await post('/api/auth/login', { username: 'owner', password: 'test-password-only', captchaId: challenge.id, captcha: '12345' }, issued.headers.get('set-cookie').split(';')[0]);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/worker/ciweimao/add', { bookId: '100' }, cookie)).status, 200);
  const state = await (await fetch(origin + '/api/worker/ciweimao/status', { headers: { Cookie: cookie } })).json();
  assert.equal(state.queued, 1);
});
