import { readFile, writeFile, mkdir, rename, stat, link, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeWenkuBook } from './wenku8.mjs';

export async function readJsonFile(path, maxBytes = 1024 * 1024) {
  if ((await stat(path)).size > maxBytes) throw new Error('JSON 文件超出大小限制');
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error('JSON 格式错误，请检查文件后重试'); }
}
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
        await delay(Math.min(500, 25 * 2 ** attempt));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}
function numberOption(raw, key, fallback, minimum, maximum) {
  const value = raw[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(key + ' 参数不合法');
  return value;
}
function relativeFile(base, value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('文件路径必须是文本');
  return resolve(base, value);
}
export async function loadDownloadQueue(queuePath, { discoveredEndId = 0 } = {}) {
  const path = resolve(queuePath), base = dirname(path);
  const raw = await readJsonFile(path);
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || (raw.books !== undefined && !Array.isArray(raw.books)) || (raw.ranges !== undefined && !Array.isArray(raw.ranges)) || (!Array.isArray(raw.books) && !Array.isArray(raw.ranges))) throw new Error('队列必须包含 books 或 ranges 数组');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('不支持此队列版本');
  if ((raw.books?.length || 0) > 10000 || (raw.ranges?.length || 0) > 100) throw new Error('单份书单最多包含 10000 本书和 100 个编号范围');
  if (raw.paused !== undefined && typeof raw.paused !== 'boolean') throw new Error('paused 必须是布尔值');
  if (raw.downloadDiscovered !== undefined && typeof raw.downloadDiscovered !== 'boolean') throw new Error('downloadDiscovered 必须是布尔值');
  if (raw.autoDiscover !== undefined && typeof raw.autoDiscover !== 'boolean') throw new Error('autoDiscover 必须是布尔值');
  const queue = {
    paused: raw.paused === true,
    downloadDiscovered: raw.downloadDiscovered === true,
    autoDiscover: raw.autoDiscover === true,
    discoveryIntervalMs: numberOption(raw, 'discoveryIntervalSeconds', 1800, 30, 86400) * 1000,
    pollMs: numberOption(raw, 'pollSeconds', 15, 0.02, 3600) * 1000,
    minDelayMs: numberOption(raw, 'minDelaySeconds', 3, 0, 3600) * 1000,
    maxDelayMs: numberOption(raw, 'maxDelaySeconds', 8, 0, 3600) * 1000,
    retryMs: numberOption(raw, 'retrySeconds', 60, 0.02, 86400) * 1000,
    maxAttempts: numberOption(raw, 'maxAttempts', 3, 1, 10),
    concurrency: numberOption(raw, 'concurrency', 1, 1, 2),
    resumeToken: raw.resumeToken ?? 0, jobs: [], ranges: []
  };
  if (!Number.isInteger(queue.maxAttempts) || !Number.isInteger(queue.concurrency) || queue.maxDelayMs < queue.minDelayMs) throw new Error('重试次数、并发数或随机间隔不合法');
  if (raw.workerSlots !== undefined) {
    const slots = raw.workerSlots;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots) || Object.keys(slots).some(key => !['scan', 'download'].includes(key)) || !['scan', 'download'].every(key => Number.isInteger(slots[key]) && slots[key] >= 0 && slots[key] <= 2) || slots.scan + slots.download !== queue.concurrency) throw new Error('workerSlots 必须包含 scan 和 download 整数容量，合计等于 concurrency');
    queue.workerSlots = { scan: slots.scan, download: slots.download };
  }
  const entries = (raw.books || []).map(entry => ({ entry, fromRange: false }));
  const metadataRanges = (raw.ranges || []).filter(range => range?.enabled !== false && range?.source === 'wenku8' && (range.mode ?? 'metadata') === 'metadata');
  const extendRange = metadataRanges.reduce((last, range) => !last || range.endId > last.endId ? range : last, null);
  let expandedCount = entries.length;
  for (const range of raw.ranges || []) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) throw new Error('编号范围必须是对象');
    if (range.enabled === false) continue;
    if (range.source !== 'wenku8') throw new Error('编号范围当前仅支持 wenku8 来源');
    const start = range.startId, configuredEnd = range.endId;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(configuredEnd) || start < 1 || configuredEnd < start || configuredEnd > 99999999) throw new Error('startId、endId 必须是正整数，结束编号不能小于开始编号');
    const end = queue.autoDiscover && range === extendRange && Number.isSafeInteger(discoveredEndId) && discoveredEndId <= 99999999 ? Math.max(configuredEnd, discoveredEndId) : configuredEnd;
    if ((expandedCount += end - start + 1) > 10000) throw new Error('展开后的任务最多 10000 本，请缩小编号范围');
    const mode = range.mode ?? 'metadata';
    if (!['metadata', 'download'].includes(mode)) throw new Error('mode 只能为 metadata 或 download');
    queue.ranges.push({ source: range.source, startId: start, endId: end, mode });
    for (let id = start; id <= end; id++) entries.push({ entry: { ...range, mode, bookId: id }, fromRange: true });
  }
  const ids = new Set();
  for (const item of entries) {
    let entry = item.entry;
    if (typeof entry === 'number' || typeof entry === 'string') entry = { source: 'wenku8', bookId: entry };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('每项任务必须是对象');
    if (entry.enabled === false) continue;
    const job = { cookiesFile: relativeFile(base, entry.cookiesFile ?? raw.cookiesFile), proxy: entry.proxy ?? raw.proxy ?? 'auto' };
    if (typeof job.proxy !== 'string') throw new Error('proxy 必须是文本');
    if (entry.source === 'wenku8') {
      const source = normalizeWenkuBook(entry.bookId ?? entry.url);
      const mode = entry.mode ?? 'download';
      if (!['metadata', 'download'].includes(mode)) throw new Error('mode 只能为 metadata 或 download');
      Object.assign(job, { id: 'wenku8-' + source.id, kind: 'wenku8', source, mode });
      if (entry.manifest !== undefined) throw new Error('任务只能选择书籍来源或 manifest 其中一种');
    } else {
      if (entry.source !== undefined) throw new Error('不支持此书籍来源');
      const manifest = typeof entry.manifest === 'string' ? await readJsonFile(resolve(base, entry.manifest)) : entry.manifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('任务缺少 manifest 对象或文件路径');
      if (manifest.published === false) continue;
      if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(manifest.id || '') || typeof manifest.title !== 'string' || !manifest.title.trim()) throw new Error('任务元数据缺少合法的 id 或书名');
      if (['cookies', 'cookie', 'session', 'password', 'authorization', 'headers'].some(key => Object.hasOwn(manifest, key))) throw new Error('登录态只能通过 cookiesFile 指定，不能放进书籍元数据');
      Object.assign(job, { id: manifest.id, kind: 'manifest', manifest });
    }
    if (ids.has(job.id)) {
      if (item.fromRange) continue;
      throw new Error('书单存在重复 id：' + job.id);
    }
    ids.add(job.id);
    job.fingerprint = createHash('sha256').update(JSON.stringify({ ...job, resumeToken: queue.resumeToken, retryToken: entry.retryToken ?? 0 })).digest('hex');
    // Routing must not invalidate persisted metadata or reset a scan checkpoint.
    if (job.kind === 'wenku8' && job.mode === 'metadata' && queue.downloadDiscovered) job.autoDownload = true;
    queue.jobs.push(job);
  }
  return queue;
}

export async function readCookieOptions(path) {
  if (!path) return {};
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Cookie JSON 格式错误'); }
    const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(cookies)) throw new Error('Cookie 文件缺少 cookies 数组');
    return { cookies };
  }
  const rawCookie = text.replace(/^Cookie:\s*/i, '');
  if (!rawCookie || /[\r\n]/.test(rawCookie)) throw new Error('Cookie 文件必须包含一行有效 Cookie');
  return { rawCookie };
}
export async function credentialRevision(path) {
  if (!path) return 'no-cookie-file';
  try { const info = await stat(path); return path + ':' + info.mtimeMs + ':' + info.size; }
  catch { return path + ':missing'; }
}
export function classifyDownloadFailure(error) {
  const status = Number(error.status) || null;
  if ([401, 403].includes(status) || /登录|登錄|验证|驗證|Cookie|HTML/i.test(error.message || '')) return { kind: 'auth', code: status || 'AUTH', message: '登录态失效或需要站点验证，等待更新 Cookie' };
  if ([400, 404, 409, 410, 413, 415].includes(status) || /SHA-256|编码|Encoding|完整.*入口|全本入口|URL|Invalid URL|参数|元数据/i.test(error.message || '')) return { kind: 'permanent', code: status || 'INVALID_CONTENT', message: '文件不存在、资料不完整或校验失败，请检查任务' };
  return { kind: 'transient', code: status || error.cause?.code || error.code || 'NETWORK', message: '暂时无法完成下载，稍后重试', retryAfterMs: Math.max(0, Number(error.retryAfterMs) || 0) };
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireWorkerLock(stateDirectory, details) {
  const stateDir = resolve(stateDirectory), path = join(stateDir, 'worker.lock');
  await mkdir(stateDir, { recursive: true });
  const record = { token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), ...details };
  for (let attempt = 0; attempt < 3; attempt++) {
    const readyPath = join(stateDir, '.worker-lock-' + randomUUID() + '.tmp');
    try {
      // Publish a fully written file exclusively. Opening worker.lock with wx
      // exposes an empty JSON file to status/start readers before writeFile.
      await writeFile(readyPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await link(readyPath, path);
      return { ...record, async release() {
        let current;
        try { current = await readJsonFile(path); } catch { return; }
        if (current.token !== record.token) return;
        await rm(path, { force: true });
        try { const stop = await readJsonFile(join(stateDir, 'worker.stop')); if (stop.token === record.token) await rm(join(stateDir, 'worker.stop'), { force: true }); } catch {}
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = await readJsonFile(path); } catch { throw new Error('运行锁不完整，请确认旧进程状态后处理'); }
      if (processExists(previous.pid)) throw new Error('下载脚本已在运行，不启动第二个实例');
      const current = await readJsonFile(path);
      if (current.token === previous.token) await rm(path, { force: true });
    } finally { await rm(readyPath, { force: true }); }
  }
  throw new Error('无法取得下载脚本运行锁');
}
