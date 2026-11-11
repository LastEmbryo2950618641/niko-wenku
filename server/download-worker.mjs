import { watch } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLibrary } from './library.mjs';
import { downloadFullBook } from './downloader.mjs';
import { createNetwork } from './network.mjs';
import { fetchWenkuPage, parseWenkuInfo, parseWenkuDownloads, parseWenkuCatalog, wenkuCatalogUrl } from './wenku8.mjs';
import {
  loadDownloadQueue, readJsonFile, writeJsonAtomic, readCookieOptions,
  credentialRevision, classifyDownloadFailure, acquireWorkerLock
} from './download-queue.mjs';

const timestamp = () => new Date().toISOString();
const randomDelay = queue => queue.minDelayMs + Math.random() * (queue.maxDelayMs - queue.minDelayMs);
const laneFor = (job, entry) => job.kind === 'wenku8' && job.mode === 'metadata' && !(job.autoDownload && entry?.scanCompletedAt) ? 'scan' : 'download';
const terminalScanStates = new Set(['discovered', 'published', 'missing', 'failed']);

class QueueHold extends Error {}

async function downloadJob(job, queue, libraryRoot, stateDir, signal, beforeRequest, onProgress) {
  let network;
  try {
    let credentials;
    try { credentials = await readCookieOptions(job.cookiesFile); }
    catch { throw new Error('无法读取 Cookie 文件，请更新本地 Cookie'); }
    network = await createNetwork({ proxy: job.proxy });
    const options = { ...credentials, dispatcher: network.dispatcher, signal, beforeRequest, onProgress, minDelayMs: queue.minDelayMs, maxDelayMs: queue.maxDelayMs };
    let manifest = job.manifest;
    if (job.kind === 'wenku8') {
      await onProgress?.({ phase: 'metadata', receivedBytes: 0, totalBytes: null });
      if (job.useCatalog) {
        try {
          const cached = await readJsonFile(join(stateDir, 'catalog', job.id + '.json'));
          if (cached.id === job.id && cached.source?.id === job.source.id) manifest = cached;
        } catch { /* Missing cache is refetched without discarding the scan checkpoint. */ }
      }
      if (!manifest) {
        manifest = parseWenkuInfo(await fetchWenkuPage(job.source.infoUrl, options), job.source.id);
        await writeJsonAtomic(join(stateDir, 'catalog', job.id + '.json'), manifest);
      }
      if (job.mode === 'metadata') return { kind: 'metadata', title: manifest.title, author: manifest.author };
      if (!manifest.source.downloadPageUrl) throw new Error('资料页缺少完整 TXT 全本入口');
      await onProgress?.({ phase: 'download_page', receivedBytes: 0, totalBytes: null });
      manifest.downloadVariants = parseWenkuDownloads(await fetchWenkuPage(manifest.source.downloadPageUrl, options), job.source.id);
      await writeJsonAtomic(join(stateDir, 'prepared', job.id + '.json'), manifest);
    }
    signal.throwIfAborted();
    return await downloadFullBook(libraryRoot, manifest, undefined, options);
  } finally { await network?.dispatcher.close(); }
}

/** Poll book lists and bounded numeric ranges; publish only validated whole files. */
export async function runDownloadWorker({ queuePath, libraryRoot, stateDir, once = false, signal: externalSignal, onEvent } = {}) {
  queuePath = resolve(queuePath);
  libraryRoot = resolve(libraryRoot);
  stateDir = resolve(stateDir);
  const lock = await acquireWorkerLock(stateDir, { queuePath, libraryRoot });
  const statePath = join(stateDir, 'worker-state.json');
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const library = createLibrary(libraryRoot);
  const attempted = new Set();
  const active = new Map();
  let state, watcher, activeIds, currentJobs, fatalError, checkedCatalogThisRun = false;
  let libraryRevision = 0;
  let writes = Promise.resolve(), requests = Promise.resolve();
  async function checkStop() {
    try {
      const requested = await readJsonFile(join(stateDir, 'worker.stop'));
      if (requested.token === lock.token) controller.abort();
    } catch { /* A missing or partially written control file is not a stop request. */ }
  }
  async function save() {
    state.heartbeatAt = timestamp();
    state.activeBookIds = [...active.keys()];
    if (state.activeBookIds.length) state.activeBookId = state.activeBookIds[0];
    else delete state.activeBookId;
    if (!['paused', 'auth_required', 'cooldown', 'config_error', 'stopped', 'idle'].includes(state.status)) {
      const phases = state.activeBookIds.map(id => state.books[id]?.status);
      state.status = phases.includes('downloading') ? 'downloading' : phases.includes('discovering') ? 'discovering' : 'processing';
    }
    if (activeIds) {
      const counts = { total: activeIds.size, published: 0, discovered: 0, missing: 0, failed: 0, pending: 0, downloading: 0, discovering: 0, retry_wait: 0, auth_required: 0 };
      for (const id of activeIds) {
        const status = state.books[id]?.status;
        if (Object.hasOwn(counts, status)) counts[status]++;
      }
      state.progress = counts;
    }
    if (currentJobs) {
      const lanes = { scan: { pending: 0, completed: 0 }, download: { pending: 0, completed: 0 } };
      for (const job of currentJobs.values()) {
        const entry = state.books[job.id], status = entry?.status;
        const name = laneFor(job, entry), lane = lanes[name];
        if (job.autoDownload && entry?.scanCompletedAt) lanes.scan.completed++;
        if (['pending', 'retry_wait', 'auth_required'].includes(status) || (name === 'download' && status === 'discovered')) lane.pending++;
        else if (['discovered', 'published'].includes(status)) lane.completed++;
      }
      state.workers = Object.fromEntries(Object.entries(lanes).map(([name, counts]) => {
        const activeBookIds = [...active].filter(([, task]) => task.lane === name).map(([id]) => id);
        const capacity = state.workerSlots?.[name] ?? state.concurrency;
        const status = !state.running || state.status === 'stopped' ? 'stopped'
          : ['paused', 'auth_required', 'cooldown', 'config_error'].includes(state.status) ? state.status
          : activeBookIds.length ? name === 'scan' ? 'scanning' : 'downloading'
          : capacity === 0 ? 'disabled' : counts.pending ? 'waiting_for_slot' : 'waiting_for_tasks';
        return [name, { capacity, status, activeBookIds, ...counts }];
      }));
      state.scanCheckpoints = (state.ranges || []).filter(range => range.mode === 'metadata').map(range => {
        let nextId = range.startId;
        for (; nextId <= range.endId; nextId++) {
          const id = 'wenku8-' + nextId, job = currentJobs.get(id);
          if (job && !state.books[id]?.scanCompletedAt && laneFor(job) === 'scan' && !terminalScanStates.has(state.books[id]?.status)) break;
        }
        return { source: range.source, startId: range.startId, endId: range.endId, lastCompletedId: nextId - 1, nextId: nextId <= range.endId ? nextId : null };
      });
    }
    const snapshot = structuredClone(state);
    const write = writes.then(() => writeJsonAtomic(statePath, snapshot));
    writes = write.catch(() => {});
    await write;
  }
  async function emit(event, detail = {}) { await onEvent?.({ event, at: timestamp(), ...detail }); }
  function cancelPeers(exceptId) {
    for (const [id, task] of active) if (id !== exceptId) task.controller.abort();
  }
  async function waitForWork(ms) {
    const timeout = new AbortController();
    try {
      await Promise.race([
        ...[...active.values()].map(task => task.promise),
        delay(ms, undefined, { signal: AbortSignal.any([signal, timeout.signal]) })
      ]);
    } finally { timeout.abort(); }
  }
  function permitRequest(queue, taskSignal) {
    const permit = requests.then(async () => {
      taskSignal.throwIfAborted();
      if (state.authRequired || Date.parse(state.cooldownUntil) > Date.now()) throw new QueueHold();
      const previous = Date.parse(state.lastRequestAt) || 0;
      const waitMs = previous + randomDelay(queue) - Date.now();
      if (waitMs > 0) await delay(waitMs, undefined, { signal: taskSignal });
      await checkStop();
      taskSignal.throwIfAborted();
      if (state.authRequired || Date.parse(state.cooldownUntil) > Date.now()) throw new QueueHold();
      let config;
      try { config = await readJsonFile(queuePath); } catch { throw new QueueHold(); }
      if (config.paused) throw new QueueHold();
      state.lastRequestAt = timestamp();
    });
    requests = permit.catch(() => {});
    return permit;
  }
  async function discoverRange(queue, job) {
    const previous = state.discovery || {};
    state.discovery = { ...previous, status: 'checking', checkedAt: timestamp() };
    checkedCatalogThisRun = true;
    let network;
    try {
      await save();
      await emit('checking_catalog');
      const credentials = await readCookieOptions(job.cookiesFile);
      network = await createNetwork({ proxy: job.proxy });
      const result = parseWenkuCatalog(await fetchWenkuPage(wenkuCatalogUrl, { ...credentials, dispatcher: network.dispatcher, signal, beforeRequest: () => permitRequest(queue, signal) }));
      const knownMaxId = Math.max(previous.knownMaxId || 0, result.highestId);
      // Validate expansion before retaining it; never corrupt a working queue.
      await loadDownloadQueue(queuePath, { discoveredEndId: knownMaxId });
      state.discovery = { status: 'ready', knownMaxId, lastCheckedAt: timestamp(), nextCheckAt: new Date(Date.now() + queue.discoveryIntervalMs).toISOString() };
      await emit('catalog_checked', { highestId: knownMaxId });
    } catch (error) {
      if (signal.aborted || error instanceof QueueHold) { state.discovery = { ...previous, status: 'waiting' }; return; }
      const failure = classifyDownloadFailure(error);
      state.discovery = { ...previous, status: 'retry_wait', lastCheckedAt: timestamp(), nextCheckAt: new Date(Date.now() + Math.max(queue.retryMs, 60000, error.retryAfterMs || 0)).toISOString(), message: '新编号检查暂未成功，将自动重试；已知编号继续处理' };
      if (failure.kind === 'auth') {
        state.authRequired = { bookId: job.id, sourceDiscovery: true, credentialRevision: await credentialRevision(job.cookiesFile), resumeToken: JSON.stringify(queue.resumeToken) };
        state.status = 'auth_required';
        state.discovery.message = '检查新编号需要更新登录态，更新后自动继续';
        cancelPeers();
      }
      if (error.status === 429) {
        state.cooldownUntil = new Date(Date.now() + Math.max(queue.retryMs, error.retryAfterMs || 0)).toISOString();
        state.status = 'cooldown';
        cancelPeers();
      }
      await emit('catalog_retry', { nextAttemptAt: state.discovery.nextCheckAt });
    } finally { await network?.dispatcher.close(); await save(); }
  }
  async function processJob(job, queue, taskController) {
    const taskSignal = AbortSignal.any([signal, taskController.signal]);
    const entry = state.books[job.id];
    entry.transfer = { phase: 'preparing', receivedBytes: 0, totalBytes: null, updatedAt: timestamp() };
    entry.status = job.mode === 'metadata' ? 'discovering' : 'downloading';
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptAt = timestamp();
    delete entry.nextAttemptAt;
    state.status = entry.status;
    const cookieRevision = await credentialRevision(job.cookiesFile);
    attempted.add(laneFor(job) + ':' + job.id);
    try {
      await save();
      await emit(entry.status, { id: job.id, attempt: entry.attempts });
      const receipt = await downloadJob(job, queue, libraryRoot, stateDir, taskSignal, () => permitRequest(queue, taskSignal), async progress => {
        entry.transfer = { ...progress, updatedAt: timestamp() };
        await save();
      });
      if (receipt.kind === 'metadata') {
        Object.assign(entry, { status: 'discovered', title: receipt.title, author: receipt.author, completedAt: timestamp(), scanCompletedAt: timestamp() });
        if (job.autoDownload) entry.attempts = 0;
      }
      else {
        libraryRevision++;
        Object.assign(entry, { status: 'published', language: receipt.language, encoding: receipt.encoding, bytes: receipt.bytes, sha256: receipt.sha256, chapters: receipt.chapters, completedAt: timestamp() });
      }
      if (receipt.cover) {
        entry.cover = receipt.cover;
        if (receipt.cover.code === 429 || (receipt.cover.code === 503 && receipt.cover.retryAfterMs > 0)) {
          state.cooldownUntil = new Date(Date.now() + Math.max(queue.retryMs, receipt.cover.retryAfterMs || 0)).toISOString();
          state.status = 'cooldown';
          cancelPeers(job.id);
        }
      }
      delete entry.error;
      state.lastFinishedAt = timestamp();
      if (!state.authRequired && !(Date.parse(state.cooldownUntil) > Date.now())) state.status = 'processing';
      await save();
      await emit(entry.status, { id: job.id, title: receipt.title, language: receipt.language, bytes: receipt.bytes });
      if (receipt.cover) await emit(receipt.cover.status === 'downloaded' ? 'cover_saved' : 'cover_skipped', { id: job.id });
    } catch (error) {
      if (taskSignal.aborted || error instanceof QueueHold) {
        if (!['published', 'discovered'].includes(entry.status)) {
          entry.status = 'pending';
          entry.attempts = Math.max(0, entry.attempts - 1);
        }
        if (error instanceof QueueHold) cancelPeers(job.id);
        return;
      }
      const failure = classifyDownloadFailure(error);
      entry.error = { kind: failure.kind, code: failure.code, message: failure.message };
      entry.failedAt = timestamp();
      state.lastFinishedAt = timestamp();
      if (error.status === 429) {
        state.cooldownUntil = new Date(Date.now() + Math.max(queue.retryMs, Math.min(86400000, failure.retryAfterMs || 0))).toISOString();
        state.status = 'cooldown';
        cancelPeers(job.id);
      }
      if (failure.kind === 'auth') {
        entry.status = 'auth_required';
        state.authRequired = { bookId: job.id, credentialRevision: cookieRevision, resumeToken: JSON.stringify(queue.resumeToken) };
        state.status = 'auth_required';
        cancelPeers(job.id);
      } else if ([404, 410].includes(error.status)) entry.status = 'missing';
      else if (failure.kind === 'permanent' || entry.attempts >= queue.maxAttempts) entry.status = 'failed';
      else {
        entry.status = 'retry_wait';
        const backoff = Math.min(86400000, queue.retryMs * 2 ** (entry.attempts - 1));
        entry.nextAttemptAt = new Date(Date.now() + Math.max(backoff, Math.min(86400000, failure.retryAfterMs || 0))).toISOString();
      }
      await save();
      await emit(entry.status, { id: job.id, message: failure.message, nextAttemptAt: entry.nextAttemptAt });
    }
  }
  try {
    let previous;
    try { previous = await readJsonFile(statePath, 16 * 1024 * 1024); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('下载状态无法读取，请保留状态文件并检查 JSON');
    }
    if (previous && (previous.queuePath !== queuePath || previous.libraryRoot !== libraryRoot)) throw new Error('此状态目录属于另一份队列或书库，请使用独立的 --state-dir');
    state = {
      ...previous, version: 1, running: true, pid: process.pid, startedAt: timestamp(),
      queuePath, libraryRoot, status: 'starting', books: Object.assign(Object.create(null), previous?.books)
    };
    for (const entry of Object.values(state.books)) {
      if (['downloading', 'discovering'].includes(entry.status)) { entry.status = 'pending'; entry.attempts = Math.max(0, (entry.attempts || 1) - 1); }
    }
    watcher = watch(stateDir, (_event, filename) => {
      if (String(filename) === 'worker.stop') void checkStop();
    });
    watcher.on('error', () => controller.abort());
    await save();
    await emit('started');
    while (!signal.aborted) {
      await checkStop();
      if (signal.aborted) break;
      let queue;
      try { queue = await loadDownloadQueue(queuePath, { discoveredEndId: state.discovery?.knownMaxId || 0 }); }
      catch {
        state.status = 'config_error';
        state.message = '队列暂不可读取或格式错误，修正后会自动恢复';
        await save();
        await emit('config_error', { message: state.message });
        if (once) break;
        await delay(1000, undefined, { signal });
        continue;
      }
      delete state.message;
      const revisionBeforeScan = libraryRevision;
      const snapshot = await library.scan();
      // A task can publish while the filesystem scan is awaiting I/O. Do not
      // reset that publication to pending using an older directory snapshot.
      if (revisionBeforeScan !== libraryRevision) continue;
      const existing = new Map(snapshot.books.map(book => [book.id, book]));
      state.queueSize = queue.jobs.length;
      state.concurrency = queue.concurrency;
      state.workerSlots = queue.workerSlots;
      activeIds = new Set(queue.jobs.map(job => job.id));
      currentJobs = new Map(queue.jobs.map(job => [job.id, job]));
      state.ranges = queue.ranges;
      state.libraryCount = snapshot.books.length;
      for (const job of queue.jobs) {
        if (active.has(job.id)) continue;
        const published = existing.get(job.id);
        let entry = state.books[job.id];
        if (job.autoDownload && entry?.status === 'discovered' && !entry.scanCompletedAt) {
          entry.scanCompletedAt = entry.completedAt || timestamp();
          entry.attempts = 0;
        }
        if (published) {
          state.books[job.id] = { ...entry, status: 'published', fingerprint: job.fingerprint, title: published.title, language: published.language, encoding: published.encoding, bytes: published.bytes };
          delete state.books[job.id].error;
          delete state.books[job.id].nextAttemptAt;
        } else if (!entry || entry.fingerprint !== job.fingerprint || entry.status === 'published') {
          state.books[job.id] = { status: 'pending', fingerprint: job.fingerprint, attempts: 0, title: job.manifest?.title || job.id };
        }
      }
      if (state.authRequired && !active.size) {
        const auth = state.authRequired;
        const job = queue.jobs.find(item => item.id === auth.bookId);
        if (!job || (!auth.sourceDiscovery && existing.has(job.id)) || await credentialRevision(job.cookiesFile) !== auth.credentialRevision || JSON.stringify(queue.resumeToken) !== auth.resumeToken) {
          if (job && !existing.has(job.id) && !auth.sourceDiscovery) {
            Object.assign(state.books[job.id], { status: 'pending', attempts: 0 });
            delete state.books[job.id].error;
          }
          delete state.authRequired;
          if (auth.sourceDiscovery) checkedCatalogThisRun = false;
          await emit('resumed');
        }
      }
      if (queue.paused || state.authRequired) {
        cancelPeers();
        state.status = queue.paused ? 'paused' : 'auth_required';
        await save();
        await emit(state.status);
        if (once && !active.size) break;
        await waitForWork(queue.pollMs);
        continue;
      }
      if (state.cooldownUntil) {
        const remaining = Date.parse(state.cooldownUntil) - Date.now();
        if (remaining > 0) {
          state.status = 'cooldown';
          await save();
          await emit('cooldown', { nextAttemptAt: state.cooldownUntil });
          if (once && !active.size) break;
          await waitForWork(Math.min(remaining, queue.pollMs));
          continue;
        }
        delete state.cooldownUntil;
      }
      const scanCapacity = queue.workerSlots?.scan ?? queue.concurrency;
      const catalogDue = queue.autoDiscover && (!checkedCatalogThisRun || Date.parse(state.discovery?.nextCheckAt || '') <= Date.now());
      if (catalogDue && scanCapacity > 0 && active.size < queue.concurrency && ![...active.values()].some(task => task.lane === 'scan')) {
        const sourceJob = queue.jobs.find(item => item.kind === 'wenku8' && item.mode === 'metadata');
        if (sourceJob) { await discoverRange(queue, sourceJob); continue; }
      }
      const job = queue.jobs.find(item => {
        const entry = state.books[item.id];
        const lane = laneFor(item, entry);
        if (queue.workerSlots && [...active.values()].filter(task => task.lane === lane).length >= queue.workerSlots[lane]) return false;
        return !active.has(item.id) && !existing.has(item.id) && !(once && attempted.has(lane + ':' + item.id)) &&
          (entry.status === 'pending' || (lane === 'download' && entry.status === 'discovered') || (entry.status === 'retry_wait' && Date.parse(entry.nextAttemptAt) <= Date.now()));
      });
      if (!job || active.size >= queue.concurrency) {
        if (active.size) {
          await waitForWork(queue.pollMs);
          if (fatalError) throw fatalError;
          continue;
        }
        state.status = 'idle';
        await save();
        await emit('idle');
        if (once) break;
        await delay(queue.pollMs, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      const taskController = new AbortController();
      const lane = laneFor(job, state.books[job.id]);
      const task = { controller: taskController, promise: null, lane };
      active.set(job.id, task);
      const taskJob = lane === 'download' && job.autoDownload ? { ...job, mode: 'download', useCatalog: true } : job;
      task.promise = processJob(taskJob, queue, taskController).finally(async () => {
        active.delete(job.id);
        await save();
      }).catch(error => { fatalError = error; controller.abort(); });
    }
    if (fatalError) throw fatalError;
    if (signal.aborted) state.status = 'stopped';
    return state;
  } catch (error) {
    if (fatalError || !signal.aborted || !state) throw error;
    state.status = 'stopped';
    return state;
  } finally {
    controller.abort();
    await Promise.allSettled([...active.values()].map(task => task.promise));
    watcher?.close();
    try {
      if (state) {
        state.running = false;
        state.stoppedAt = timestamp();
        delete state.activeBookId;
        await save();
      }
    } finally { await lock.release(); }
  }
}
