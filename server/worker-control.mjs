import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './download-queue.mjs';
import { ArchiveError } from './library.mjs';

const exec = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/watch-library.mjs');
const count = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const label = value => typeof value === 'string' ? value.slice(0, 250) : '';
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function optionalJson(path, limit = 16 * 1024 * 1024) {
  try { return await readJsonFile(path, limit); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function createWorkerController({ queuePath, libraryRoot, stateDir }) {
  queuePath = resolve(queuePath); libraryRoot = resolve(libraryRoot); stateDir = resolve(stateDir);
  let commands = Promise.resolve();
  async function status() {
    const [state, lock, queue, stop] = await Promise.all([
      optionalJson(join(stateDir, 'worker-state.json')), optionalJson(join(stateDir, 'worker.lock')),
      optionalJson(queuePath, 1024 * 1024), optionalJson(join(stateDir, 'worker.stop'))
    ]);
    const running = Boolean(lock && alive(lock.pid));
    const stopping = running && stop?.token === lock.token;
    const checkpoints = (state?.scanCheckpoints || []).map(range => ({ source: label(range.source), startId: count(range.startId), endId: count(range.endId), lastCompletedId: count(range.lastCompletedId), nextId: range.nextId == null ? null : count(range.nextId) }));
    const ranges = checkpoints.length ? checkpoints : (queue?.ranges || []).filter(range => range.mode !== 'download' && range.enabled !== false).map(range => ({ startId: range.startId, endId: range.endId, lastCompletedId: range.startId - 1, nextId: range.startId }));
    function lane(name) {
      const raw = state?.workers?.[name] || {};
      const current = running ? (raw.activeBookIds || []).slice(0, 2).map(id => {
        const book = state?.books?.[id] || {}, transfer = book.transfer;
        const total = count(transfer?.totalBytes) || null, received = count(transfer?.receivedBytes);
        return { id: label(id), title: label(book.title) || label(id), ...(transfer ? { transfer: {
          phase: label(transfer.phase), receivedBytes: received, totalBytes: total,
          percent: total ? Math.min(100, Math.round(received / total * 1000) / 10) : null,
          updatedAt: label(transfer.updatedAt)
        } } : {}) };
      }) : [];
      return { capacity: count(raw.capacity ?? queue?.workerSlots?.[name] ?? queue?.concurrency ?? 1), status: !running ? 'stopped' : stopping ? 'stopping' : label(raw.status) || 'starting', pending: count(raw.pending), completed: count(raw.completed), current };
    }
    const scan = lane('scan'), download = lane('download');
    scan.total = ranges.reduce((sum, range) => sum + Math.max(0, range.endId - range.startId + 1), 0);
    scan.processed = ranges.reduce((sum, range) => sum + Math.max(0, Math.min(range.endId, range.lastCompletedId) - range.startId + 1), 0);
    scan.nextId = ranges.find(range => range.nextId != null)?.nextId ?? null;
    const progress = Object.fromEntries(['total', 'published', 'discovered', 'missing', 'failed', 'pending', 'downloading', 'discovering', 'retry_wait', 'auth_required'].map(key => [key, count(state?.progress?.[key])]));
    const activity = Object.entries(state?.books || {}).filter(([, book]) => book.completedAt || book.failedAt).sort(([, a], [, b]) => (Date.parse(b.failedAt || b.completedAt) || 0) - (Date.parse(a.failedAt || a.completedAt) || 0)).slice(0, 6).map(([id, book]) => ({ id: label(id), title: label(book.title) || label(id), status: label(book.status), at: label(book.failedAt || book.completedAt), ...(book.error ? { code: typeof book.error.code === 'number' ? book.error.code : label(book.error.code), message: label(book.error.message) } : {}) }));
    return {
      available: true, running, stopping, pid: running ? lock.pid : null,
      status: stopping ? 'stopping' : running ? label(state?.status) || 'starting' : state ? 'stopped' : 'not_started',
      heartbeatAt: label(state?.heartbeatAt), startedAt: label(state?.startedAt),
      cooldownUntil: label(state?.cooldownUntil), needsAuthentication: Boolean(state?.authRequired),
      interval: { minSeconds: count(queue?.minDelaySeconds ?? 3), maxSeconds: count(queue?.maxDelaySeconds ?? 8) },
      discovery: { enabled: queue?.autoDiscover === true, status: label(state?.discovery?.status) || 'waiting', knownMaxId: count(state?.discovery?.knownMaxId), lastCheckedAt: label(state?.discovery?.lastCheckedAt), nextCheckAt: label(state?.discovery?.nextCheckAt), message: label(state?.discovery?.message), intervalSeconds: count(queue?.discoveryIntervalSeconds ?? 1800) },
      scan, download, progress, scanCheckpoints: checkpoints, activity
    };
  }
  async function command(action) {
    const lock = await optionalJson(join(stateDir, 'worker.lock'));
    if (lock && alive(lock.pid) && (resolve(lock.queuePath || queuePath) !== queuePath || resolve(lock.libraryRoot || libraryRoot) !== libraryRoot)) throw new ArchiveError('此状态目录属于另一份书库，未修改其后台任务', 409);
    if (action === 'start' && lock && alive(lock.pid)) return status();
    if (action === 'stop' && (!lock || !alive(lock.pid))) return status();
    try {
      await exec(process.execPath, [script, '--queue', queuePath, '--library', libraryRoot, '--state-dir', stateDir, action === 'start' ? '--background' : '--stop'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    } catch {
      throw new ArchiveError(action === 'start' ? '后台启动未确认，请检查本机任务日志' : '停止结果未确认，请稍后刷新状态', 503);
    }
    return status();
  }
  function serialize(action) {
    const next = commands.then(() => command(action));
    commands = next.catch(() => {});
    return next;
  }
  return { status, start: () => serialize('start'), stop: () => serialize('stop') };
}
