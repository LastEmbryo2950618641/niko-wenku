import { readFile, mkdir, writeFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJsonFile, writeJsonAtomic, acquireWorkerLock } from './download-queue.mjs';
import { publishBundle } from './library.mjs';
import { createCiweimaoClient, ciweimaoId, CIWEIMAO_CATEGORY } from './ciweimao.mjs';

export async function optionalJson(path) {
  try { return await readJsonFile(path, 16 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function loadCiweimaoQueue(stateDir) {
  const raw = await optionalJson(join(stateDir, 'queue.json')) || { version: 1, books: [], intervalSeconds: 1800 };
  if (raw.version !== 1 || !Array.isArray(raw.books) || raw.books.length > 500) throw new Error('刺猬猫队列格式错误或超过 500 本');
  const intervalSeconds = raw.intervalSeconds ?? 1800;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400) throw new Error('同步间隔必须为 60–86400 秒');
  if (raw.autoDiscover !== undefined && typeof raw.autoDiscover !== 'boolean') throw new Error('autoDiscover 必须为布尔值');
  if (raw.excludedBookIds !== undefined && (!Array.isArray(raw.excludedBookIds) || raw.excludedBookIds.length > 10000)) throw new Error('忽略作品列表格式错误');
  return { version: 1, books: [...new Set(raw.books.map(ciweimaoId))], intervalSeconds, autoDiscover: raw.autoDiscover !== false,
    excludedBookIds: [...new Set((raw.excludedBookIds || []).map(ciweimaoId))] };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function saveText(path, text) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export const catalogFingerprint = book => sha256(JSON.stringify({ title: book.title, author: book.author, description: book.description, status: book.status, chapters: book.chapters }));
export async function syncCiweimaoBook({ id, libraryRoot, stateDir, client, signal, catalog, onProgress = async () => {} }) {
  id = ciweimaoId(id);
  const book = catalog || await client.catalog(id), cacheDir = join(stateDir, 'cache', id);
  await mkdir(cacheDir, { recursive: true });
  const previous = await optionalJson(join(cacheDir, 'manifest.json'));
  const rows = [], contents = [];
  const free = book.chapters.filter(chapter => chapter.free);
  const progress = { title: book.title, total: free.length, completed: 0, downloaded: 0, reused: 0, skipped: book.chapters.length - free.length, sourceTotal: book.chapters.length, phase: 'chapters' };
  const saveCache = (complete = false) => {
    const savedIds = new Set(rows.map(row => row.id));
    const retained = complete ? [] : (previous?.chapters || []).filter(row => !savedIds.has(row.id));
    return writeJsonAtomic(join(cacheDir, 'manifest.json'), { bookId: id, chapters: [...rows, ...retained] });
  };
  await onProgress(progress);
  try {
    for (const chapter of free) {
      signal?.throwIfAborted();
      const old = previous?.chapters?.find(row => row.id === chapter.id && row.title === chapter.title);
      const path = join(cacheDir, `${chapter.id}.txt`);
      let text;
      if (old?.sha256) {
        try { const buffer = await readFile(path); if (buffer.length && sha256(buffer) === old.sha256) text = buffer.toString('utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (text !== undefined) progress.reused++;
      else {
        try { text = await client.content(id, chapter); }
        catch (error) { if (error.code !== 'PAID') throw error; progress.skipped++; progress.completed++; await onProgress({ ...progress, chapterTitle: chapter.title }); continue; }
        if (typeof text !== 'string' || !text.trim()) throw new Error('免费正文为空，未发布');
        await saveText(path, text);
        progress.downloaded++;
      }
      rows.push({ id: chapter.id, title: chapter.title, sha256: sha256(Buffer.from(text)) });
      contents.push(`第${contents.length + 1}章 ${chapter.title}\n\n${text}\n`);
      progress.completed++;
      await saveCache();
      await onProgress({ ...progress, chapterTitle: chapter.title });
    }
  } catch (error) {
    await saveCache();
    throw error;
  }
  await saveCache(true);
  if (!contents.length) return { ...progress, status: 'empty', message: '该作品当前没有可下载的免费正文' };
  signal?.throwIfAborted();
  const body = Buffer.from(`${book.title}\n作者：${book.author}\n来源：${book.url}\n仅包含公开免费章节。\n\n${contents.join('\n')}`);
  const destination = join(libraryRoot, `ciweimao-${id}`, 'book.json');
  const oldBook = await optionalJson(destination);
  if (oldBook && (oldBook.source?.name !== '刺猬猫' || String(oldBook.source?.bookId) !== id)) throw new Error('相同书籍 ID 已被其他来源占用，未替换');
  if (oldBook?.integrity?.sha256 === sha256(body) && oldBook.category === CIWEIMAO_CATEGORY && oldBook.source?.catalogFingerprint === catalogFingerprint(book)) {
    // A damaged/missing published file must be repaired even if its manifest hash matches.
    try { if (sha256(await readFile(join(libraryRoot, `ciweimao-${id}`, 'content.txt'))) === sha256(body)) return { ...progress, status: 'synced', unchanged: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await onProgress({ ...progress, phase: 'publishing' });
  await publishBundle(libraryRoot, {
    id: `ciweimao-${id}`, title: book.title, author: book.author, description: book.description,
    category: CIWEIMAO_CATEGORY, tags: ['刺猬猫', '免费章节'], status: book.status,
    language: 'zh-Hans', encoding: 'utf-8', updatedAt: new Date().toISOString(), files: { text: 'content.txt' },
    source: { name: '刺猬猫', bookId: id, url: book.url, freeOnly: true, catalogFingerprint: catalogFingerprint(book), freeChapterCount: contents.length, skippedChapterCount: progress.skipped, totalChapterCount: book.chapters.length }
  }, { 'content.txt': body }, { replaceExisting: !!oldBook });
  return { ...progress, status: 'synced', unchanged: false };
}

export async function runCiweimaoWorker({ stateDir, libraryRoot, once = false, signal: externalSignal, createClient = createCiweimaoClient, pollMs = 2000, now = Date.now } = {}) {
  stateDir = resolve(stateDir); libraryRoot = resolve(libraryRoot);
  const previousState = await optionalJson(join(stateDir, 'worker-state.json'));
  const lock = await acquireWorkerLock(stateDir, { libraryRoot, source: 'ciweimao' });
  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  if (externalSignal?.aborted) abort.abort();
  let client, checking = false;
  const statePath = join(stateDir, 'worker-state.json');
  const state = { version: 2, status: 'starting', startedAt: new Date().toISOString(), books: {}, running: true, current: null,
    scan: { nextPage: 1, processedPages: 0, totalPages: 0, discovered: 0, cycle: 1, ...previousState?.scan },
    update: { checked: 0, upToDate: 0, pending: 0, updated: 0 }, lanes: { scan: null, download: null, update: null } };
  const records = new Map(), jobsDir = join(stateDir, 'books'), active = new Map();
  let queue, fatal, writes = Promise.resolve();
  const storeRecord = async record => { records.set(record.id, record); await writeJsonAtomic(join(jobsDir, record.id + '.json'), record); };
  function save() {
    state.heartbeatAt = new Date().toISOString();
    const all = [...records.values()].filter(record => !queue?.excludedBookIds.includes(record.id));
    state.books = Object.fromEntries(all.slice(-100).map(record => [record.id, record]));
    state.progress = { total: all.length, published: all.filter(row => row.published).length, failed: all.filter(row => row.status === 'failed').length,
      pending: all.filter(row => !row.published && ['pending', 'failed'].includes(row.status)).length };
    state.current = state.lanes.download || state.lanes.update;
    if (state.running && !['access_required', 'error'].includes(state.status)) state.status = active.size ? 'syncing' : 'idle';
    const snapshot = structuredClone(state);
    const write = writes.then(() => writeJsonAtomic(statePath, snapshot)); writes = write.catch(() => {}); return write;
  }
  function launch(lane, task) {
    const promise = Promise.resolve().then(task).catch(error => { if (!abort.signal.aborted) { fatal = error; abort.abort(); } })
      .finally(() => { active.delete(lane); state.lanes[lane] = null; });
    active.set(lane, promise);
  }
  function handleRestriction(error) {
    if (error.code === 'ACCESS') { state.status = 'access_required'; state.message = error.message.slice(0, 250); abort.abort(); }
  }
  async function discover() {
    const page = state.scan.nextPage;
    state.lanes.scan = { page }; await save();
    try {
      const found = await client.discover(page);
      for (const book of found.books) {
        if (records.has(book.id) || queue.excludedBookIds.includes(book.id)) continue;
        await storeRecord({ id: book.id, title: book.title, status: 'pending', discoveredAt: new Date().toISOString() });
      }
      state.scan = { ...state.scan, processedPages: page, totalPages: found.totalPages, nextPage: page + 1,
        discovered: records.size, message: '', retryAt: null };
      if (page >= found.totalPages) {
        state.scan.nextPage = 1; state.scan.cycle++;
        state.scan.nextCheckAt = new Date(now() + queue.intervalSeconds * 1000).toISOString();
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      state.scan.message = error.message.slice(0, 250);
      state.scan.retryAt = new Date(now() + 60000).toISOString();
      handleRestriction(error);
    }
    await save();
  }
  async function synchronize(record, lane) {
    const id = record.id;
    state.lanes[lane] = { id, title: record.title || id, phase: 'catalog' }; await save();
    try {
      let catalog;
      if (lane === 'update') {
        catalog = await client.catalog(id);
        state.update.checked++;
        const old = await optionalJson(join(libraryRoot, `ciweimao-${id}`, 'book.json'));
        let intact = false;
        if (old?.source?.catalogFingerprint === catalogFingerprint(catalog)) {
          try { intact = old.integrity?.sha256 === sha256(await readFile(join(libraryRoot, `ciweimao-${id}`, 'content.txt'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (intact) {
          state.update.upToDate++;
          await storeRecord({ ...record, status: 'synced', message: '', unchanged: true, checkedAt: new Date(now()).toISOString(), nextSyncAt: new Date(now() + queue.intervalSeconds * 1000).toISOString() });
          return;
        }
        state.update.pending++; state.lanes[lane].phase = 'updating'; await save();
      }
      const result = await syncCiweimaoBook({ id, libraryRoot, stateDir, client, signal: abort.signal, catalog,
        onProgress: async progress => { state.lanes[lane] = { id, ...progress }; await save(); } });
      if (lane === 'update' && !result.unchanged) state.update.updated++;
      await storeRecord({ ...record, ...result, id, published: record.published || result.status === 'synced', message: result.message || '',
        checkedAt: new Date(now()).toISOString(), nextSyncAt: new Date(now() + queue.intervalSeconds * 1000).toISOString() });
    } catch (error) {
      if (abort.signal.aborted) return;
      await storeRecord({ ...record, ...state.lanes[lane], id, status: 'failed', message: error.message.slice(0, 250), checkedAt: new Date(now()).toISOString(), nextSyncAt: new Date(now() + queue.intervalSeconds * 1000).toISOString() });
      handleRestriction(error);
    } finally { state.update.pending = 0; await save(); }
  }
  const checkStop = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { const stop = await optionalJson(join(stateDir, 'worker.stop')); if (stop?.token === lock.token) abort.abort(); }
    catch { abort.abort(); }
    finally { checking = false; }
  }, 200);
  try {
    await mkdir(jobsDir, { recursive: true });
    for (const name of await readdir(jobsDir)) {
      if (!/^[1-9]\d{0,11}\.json$/.test(name)) continue;
      const record = await optionalJson(join(jobsDir, name));
      if (record && ciweimaoId(record.id) + '.json' === name) records.set(record.id, record);
    }
    // Upgrade the earlier manually managed queue without discarding its downloads.
    if (previousState?.version !== 2) for (const record of Object.values(previousState?.books || {})) {
      await storeRecord({ ...record, published: record.status === 'synced' });
    }
    await save();
    client = await createClient({ signal: abort.signal, cookieFile: join(stateDir, 'auth.json') });
    do {
      abort.signal.throwIfAborted();
      queue = await loadCiweimaoQueue(stateDir);
      for (const id of queue.books) if (!records.has(id)) await storeRecord({ id, status: 'pending' });
      const due = date => !date || Date.parse(date) <= now();
      if (queue.autoDiscover && !active.has('scan') && due(state.scan.nextCheckAt) && due(state.scan.retryAt)) launch('scan', discover);
      if (once && active.has('scan')) await active.get('scan');
      if (abort.signal.aborted) break;
      const available = [...records.values()].filter(record => !queue.excludedBookIds.includes(record.id) && due(record.nextSyncAt));
      for (const lane of ['download', 'update']) {
        if (active.has(lane)) continue;
        const record = available.find(row => (lane === 'update') === !!row.published);
        if (record) launch(lane, () => synchronize(record, lane));
      }
      if (once) {
        await Promise.all(active.values());
        // Drain newly discovered first downloads; do not loop update/discovery forever.
        for (const record of available.filter(row => !row.published).slice(1)) {
          if (abort.signal.aborted) break;
          await synchronize(record, 'download');
        }
      }
      await save();
      if (!once) await delay(pollMs, undefined, { signal: abort.signal });
    } while (!once);
  } catch (error) {
    if (!abort.signal.aborted) fatal = error;
  } finally {
    abort.abort(); await Promise.all(active.values());
    clearInterval(checkStop);
    externalSignal?.removeEventListener('abort', forwardAbort);
    state.running = false; state.current = null;
    if (fatal) { state.status = 'error'; state.message = fatal.message.slice(0, 250); }
    else if (state.status !== 'access_required') state.status = 'stopped';
    try { await save(); }
    finally { try { await client?.close(); } finally { await lock.release(); } }
  }
  if (fatal) throw fatal;
}
