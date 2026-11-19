import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runCiweimaoWorker, optionalJson, loadCiweimaoQueue } from '../server/ciweimao-worker.mjs';
import { writeJsonAtomic } from '../server/download-queue.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
export function processAlive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, library: { type: 'string' }, background: { type: 'boolean' }, stop: { type: 'boolean' }, once: { type: 'boolean' } } });
const stateDir = resolve(values['state-dir'] || join(root, '.state', 'ciweimao'));
const libraryRoot = resolve(values.library || process.env.ARCHIVE_LIBRARY || join(root, 'library'));
const lockPath = join(stateDir, 'worker.lock');
try {
  if (values.stop) {
    const lock = await optionalJson(lockPath);
    if (lock && processAlive(lock.pid)) {
      if (resolve(lock.libraryRoot) !== libraryRoot) throw new Error('运行锁属于其他书库');
      await writeJsonAtomic(join(stateDir, 'worker.stop'), { token: lock.token });
      for (let i = 0; i < 100 && processAlive(lock.pid); i++) { await delay(100); if ((await optionalJson(lockPath))?.token !== lock.token) break; }
    }
  } else if (values.background) {
    await loadCiweimaoQueue(stateDir);
    const lock = await optionalJson(lockPath);
    if (lock && processAlive(lock.pid)) throw new Error('刺猬猫同步任务已经运行');
    await mkdir(stateDir, { recursive: true });
    const stdout = await open(join(stateDir, 'worker.stdout.log'), 'a'), stderr = await open(join(stateDir, 'worker.stderr.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [script, '--state-dir', stateDir, '--library', libraryRoot], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      child.unref();
    } finally { await stdout.close(); await stderr.close(); }
    let started = false;
    for (let i = 0; i < 70; i++) {
      await delay(100);
      if ((await optionalJson(lockPath))?.pid === child.pid) { started = true; break; }
      if (!processAlive(child.pid)) break;
    }
    if (!started) throw new Error('刺猬猫后台任务启动未确认');
    console.log('刺猬猫后台同步已启动');
  } else {
    const abort = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
    await runCiweimaoWorker({ stateDir, libraryRoot, once: values.once, signal: abort.signal });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
