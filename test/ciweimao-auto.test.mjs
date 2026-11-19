import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createCiweimaoClient, parseCiweimaoBookList } from '../server/ciweimao.mjs';
import { runCiweimaoWorker } from '../server/ciweimao-worker.mjs';
import { createCiweimaoController } from '../server/ciweimao-control.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ciweimao-auto-'));
  const stateDir = join(root, 'state'), libraryRoot = join(root, 'library');
  await mkdir(stateDir); await mkdir(libraryRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, libraryRoot };
}
const book = id => ({ id, title: '原创' + id, author: '测试', description: '测试', status: '连载中（免费章节）', url: `https://www.ciweimao.com/book/${id}`, chapters: [{ id: id + '1', title: '开端', free: true, index: 1 }] });
const pageHtml = (page, total = 3) => `<table class="book-list-table"><tr><td class="name"><a href="https://www.ciweimao.com/book/100">测试书</a></td><td class="author">作者</td></tr></table><input id="curr_page" value="${page}"><ul class="pagination"><li class="pageSkip"><i>${total}</i></li></ul>`;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function until(check) {
  for (let i = 0; i < 400; i++) {
    try { const result = await check(); if (result) return result; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('状态未在 4 秒内就绪');
}

test('book-list discovery validates page identity and honors the advertised verification boundary on resume', async () => {
  assert.equal(parseCiweimaoBookList(pageHtml(2), 2).books[0].id, '100');
  assert.throws(() => parseCiweimaoBookList(pageHtml(1), 2), error => error.code === 'ACCESS');
  assert.throws(() => parseCiweimaoBookList('<html>登录</html>', 1));
  const visited = [];
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 0, fetchImpl: async url => {
    visited.push(url.pathname);
    return new Response(pageHtml(1, 100) + "<script>if (page>=20 && !HB.util.Cookie.get('booklistCode')) { return; }</script>");
  } });
  try {
    await assert.rejects(client.discover(20), error => error.code === 'ACCESS');
    assert.deepEqual(visited, ['/book_list/0-0-0-0-0-0/quanbu/1']);
  } finally { await client.close(); }
});

test('concurrent client requests share one request-spacing gate', async () => {
  const starts = [];
  const client = await createCiweimaoClient({ proxy: 'direct', delayMs: 30, fetchImpl: async () => {
    starts.push(Date.now()); return new Response('<div class="rank-book-list"></div>');
  } });
  try {
    await Promise.all([client.search('一'), client.search('二'), client.search('三')]);
    assert.ok(starts[1] - starts[0] >= 25); assert.ok(starts[2] - starts[1] >= 25);
  } finally { await client.close(); }
});

test('empty configuration automatically discovers and downloads, deduplicates and resumes at the next page', async t => {
  const f = await fixture(t), pages = [], downloads = [];
  const client = { async discover(page) { pages.push(page); return { page, totalPages: 3, books: [{ id: '100' }, { id: '100' }, ...(page === 2 ? [{ id: '200' }] : [])] }; },
    async catalog(id) { return book(id); }, async content(id) { downloads.push(id); return '原创完整正文'; }, async close() {} };
  await runCiweimaoWorker({ ...f, once: true, createClient: async () => client });
  assert.deepEqual(pages, [1]); assert.deepEqual(downloads, ['100']);
  assert.equal((await json(join(f.libraryRoot, 'ciweimao-100/book.json'))).category, '刺猬猫免费章节');
  await runCiweimaoWorker({ ...f, once: true, createClient: async () => client });
  assert.deepEqual(pages, [1, 2]); assert.deepEqual(downloads, ['100', '200']);
  const state = await json(join(f.stateDir, 'worker-state.json'));
  assert.equal(state.scan.nextPage, 3); assert.equal(state.scan.discovered, 2);
  assert.equal(state.progress.published, 2);
});

test('automatic discovery has no 500-book manual-queue limit and checkpoints before downloads', async t => {
  const f = await fixture(t), controller = new AbortController();
  const client = { async discover() { return { totalPages: 3, books: Array.from({ length: 501 }, (_, index) => ({ id: String(1000 + index), title: '测试' })) }; },
    async catalog() { controller.abort(); throw new Error('cancelled'); }, async close() {} };
  await runCiweimaoWorker({ ...f, once: true, signal: controller.signal, createClient: async () => client });
  const state = await json(join(f.stateDir, 'worker-state.json'));
  assert.equal(state.progress.total, 501); assert.equal(state.scan.nextPage, 2);
  assert.equal(Object.keys(state.books).length, 100);
  assert.equal((await json(join(f.stateDir, 'books/1500.json'))).id, '1500');
});

test('scan continues during downloads and published books are checked and updated while new books download', async t => {
  const f = await fixture(t), controller = new AbortController();
  let clock = Date.now(), version = 1, blockedRelease;
  const contentCalls = [], pages = [];
  const client = {
    async discover(page) { pages.push(page); return { totalPages: 2, books: [{ id: page === 1 ? '100' : '200' }] }; },
    async catalog(id) { const value = book(id); if (id === '100' && version > 1) value.chapters.push({ id: '1002', title: '新增', free: true, index: 2 }); return value; },
    async content(id, chapter) {
      contentCalls.push(chapter.id);
      if (id === '200') await new Promise(resolve => { blockedRelease = resolve; });
      return '原创正文' + chapter.id;
    }, async close() {}
  };
  const run = runCiweimaoWorker({ ...f, signal: controller.signal, createClient: async () => client, pollMs: 10, now: () => clock });
  try {
    await until(async () => {
      const state = await json(join(f.stateDir, 'worker-state.json')).catch(() => null);
      return state?.progress.published === 1 && blockedRelease;
    });
    assert.deepEqual(pages, [1, 2]);
    version = 2; clock += 1801000;
    await until(async () => (await json(join(f.libraryRoot, 'ciweimao-100/book.json'))).source.freeChapterCount === 2);
    assert.deepEqual(contentCalls.filter(id => id.startsWith('100')), ['1001', '1002']);
    assert.equal((await json(join(f.stateDir, 'worker-state.json'))).lanes.download.id, '200');
    blockedRelease(); blockedRelease = null;
    await until(async () => (await json(join(f.stateDir, 'worker-state.json'))).progress.published === 2);
    clock += 1801000;
    await until(async () => (await json(join(f.stateDir, 'worker-state.json'))).update.upToDate >= 2);
  } finally { blockedRelease?.(); controller.abort(); await run; }
});

test('failed scan preserves its page cursor and does not prevent queued downloads', async t => {
  const f = await fixture(t);
  await writeFile(join(f.stateDir, 'queue.json'), JSON.stringify({ version: 1, books: ['100'] }));
  const client = { async discover() { throw new Error('temporarily offline'); }, async catalog(id) { return book(id); }, async content() { return '原创正文'; }, async close() {} };
  await runCiweimaoWorker({ ...f, once: true, createClient: async () => client });
  const state = await json(join(f.stateDir, 'worker-state.json'));
  assert.equal(state.scan.nextPage, 1); assert.ok(state.scan.retryAt); assert.equal(state.progress.published, 1);
});

test('removing automatically discovered books persists exclusion across rediscovery', async t => {
  const f = await fixture(t), nested = join(f.stateDir, 'ciweimao');
  const client = { async discover() { return { totalPages: 1, books: [{ id: '100' }] }; }, async catalog(id) { return book(id); }, async content() { return '原创正文'; }, async close() {} };
  await runCiweimaoWorker({ ...f, stateDir: nested, once: true, createClient: async () => client });
  const control = createCiweimaoController(f);
  await control.control('remove', { bookId: '100' });
  const state = await json(join(nested, 'worker-state.json'));
  state.scan.nextCheckAt = null;
  await writeFile(join(nested, 'worker-state.json'), JSON.stringify(state));
  await runCiweimaoWorker({ ...f, stateDir: nested, once: true, createClient: async () => client });
  assert.equal((await control.status()).queued, 0);
  assert.equal((await json(join(f.libraryRoot, 'ciweimao-100/book.json'))).source.bookId, '100');
});
