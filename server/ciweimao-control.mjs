import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { loadCiweimaoQueue, optionalJson } from './ciweimao-worker.mjs';
import { writeJsonAtomic } from './download-queue.mjs';
import { createCiweimaoClient, ciweimaoId } from './ciweimao.mjs';
import { ArchiveError } from './library.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/sync-ciweimao.mjs', import.meta.url));
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const label = value => typeof value === 'string' ? value.slice(0, 250) : '';
const count = value => Number.isFinite(value) ? Math.max(0, value) : 0;
export function createCiweimaoController({ stateDir, libraryRoot }) {
  stateDir = join(resolve(stateDir), 'ciweimao'); libraryRoot = resolve(libraryRoot);
  let commands = Promise.resolve(), searching = false;
  async function status() {
    const [state, lock, queue, stop] = await Promise.all([optionalJson(join(stateDir, 'worker-state.json')), optionalJson(join(stateDir, 'worker.lock')), loadCiweimaoQueue(stateDir), optionalJson(join(stateDir, 'worker.stop'))]);
    const running = Boolean(lock && alive(lock.pid)), stopping = running && stop?.token === lock.token;
    const summary = record => ({ id: label(record.id), title: label(record.title) || label(record.id), status: label(record.status), message: label(record.message), checkedAt: label(record.checkedAt), nextSyncAt: label(record.nextSyncAt),
      total: count(record.total), completed: count(record.completed), downloaded: count(record.downloaded), reused: count(record.reused), skipped: count(record.skipped), sourceTotal: count(record.sourceTotal), phase: label(record.phase), chapterTitle: label(record.chapterTitle), unchanged: record.unchanged === true });
    const records = new Map(Object.entries(state?.books || {}));
    for (const id of queue.books) if (!records.has(id)) records.set(id, { id, status: 'pending' });
    const books = [...records].filter(([id]) => !queue.excludedBookIds.includes(id)).map(([id, record]) => summary({ id, ...record }));
    const lane = name => running && state?.lanes?.[name] ? summary(state.lanes[name]) : null;
    return { available: true, running, stopping, status: stopping ? 'stopping' : running ? label(state?.status) || 'starting' : ['access_required', 'error'].includes(state?.status) ? state.status : 'stopped',
      intervalSeconds: queue.intervalSeconds, message: label(state?.message), current: running && state?.current ? summary(state.current) : null,
      autoDiscover: queue.autoDiscover, scan: { active: running && !!state?.lanes?.scan, nextPage: count(state?.scan?.nextPage) || 1, processedPages: count(state?.scan?.processedPages), totalPages: count(state?.scan?.totalPages), discovered: count(state?.scan?.discovered), cycle: count(state?.scan?.cycle) || 1, nextCheckAt: label(state?.scan?.nextCheckAt), retryAt: label(state?.scan?.retryAt), message: label(state?.scan?.message) },
      lanes: { download: lane('download'), update: lane('update') }, update: { checked: count(state?.update?.checked), upToDate: count(state?.update?.upToDate), pending: count(state?.update?.pending), updated: count(state?.update?.updated) },
      books: books.slice(-100), queued: count(state?.progress?.total) || books.length, pending: count(state?.progress?.pending), published: count(state?.progress?.published), failed: count(state?.progress?.failed), heartbeatAt: label(state?.heartbeatAt) };
  }
  async function control(action, payload) {
    const queue = await loadCiweimaoQueue(stateDir);
    const lock = await optionalJson(join(stateDir, 'worker.lock'));
    if (lock && alive(lock.pid) && resolve(lock.libraryRoot || '') !== libraryRoot) throw new ArchiveError('此状态目录属于另一份书库', 409);
    if (action === 'add' || action === 'remove') {
      if (!payload || Object.keys(payload).some(key => key !== 'bookId')) throw new ArchiveError('仅接受作品 ID 或官网作品链接');
      const id = ciweimaoId(payload.bookId);
      if (action === 'add') {
        queue.excludedBookIds = queue.excludedBookIds.filter(bookId => bookId !== id);
        if (!queue.books.includes(id)) queue.books.push(id);
        if (queue.books.length > 500) throw new ArchiveError('同步队列最多 500 本');
      } else {
        const state = await optionalJson(join(stateDir, 'worker-state.json'));
        if (lock && alive(lock.pid) && [state?.current?.id, state?.lanes?.download?.id, state?.lanes?.update?.id].includes(id)) throw new ArchiveError('请先停止当前作品的同步再移出队列', 409);
        queue.books = queue.books.filter(bookId => bookId !== id);
        if (!queue.excludedBookIds.includes(id)) queue.excludedBookIds.push(id);
      }
      await writeJsonAtomic(join(stateDir, 'queue.json'), queue);
      return status();
    }
    if (!payload || Object.keys(payload).length) throw new ArchiveError('此接口不接受命令、文件路径或自定义参数');
    if (action === 'start' && lock && alive(lock.pid) || action === 'stop' && (!lock || !alive(lock.pid))) return status();
    if (action === 'start' && !queue.books.length && !queue.autoDiscover) throw new ArchiveError('请先加入作品，或开启自动发现');
    try {
      await exec(process.execPath, [script, '--state-dir', stateDir, '--library', libraryRoot, action === 'start' ? '--background' : '--stop'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    } catch { throw new ArchiveError('刺猬猫任务操作未确认，请查看本机任务日志', 503); }
    return status();
  }
  return {
    status,
    control(action, payload) {
      const next = commands.then(() => control(action, payload)); commands = next.catch(() => {}); return next;
    },
    async search(keyword) {
      if (searching) throw new ArchiveError('正在搜索，请稍后再试', 429);
      searching = true; let client;
      try { client = await createCiweimaoClient(); return { books: await client.search(keyword) }; }
      finally { searching = false; await client?.close(); }
    }
  };
}
