import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { acquireWorkerLock } from '../server/download-queue.mjs';

test('a worker lock is complete JSON at the first instant another thread can read it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'archive-lock-publication-'));
  const observer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { readFileSync } = require('node:fs');
    parentPort.postMessage({ kind: 'ready' });
    (function observe() {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      let text;
      try { text = readFileSync(workerData, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { const lock = JSON.parse(text); parentPort.postMessage({ kind: 'complete', pid: lock.pid }); }
      catch { parentPort.postMessage({ kind: 'partial', bytes: text.length }); }
      return;
    }
    throw new Error('Lock did not appear');
    })();
  `, { eval: true, workerData: join(root, 'worker.lock') });
  t.after(async () => { await observer.terminate(); await rm(root, { recursive: true, force: true }); });
  const ready = new Promise((resolve, reject) => { observer.once('message', resolve); observer.once('error', reject); });
  const observed = new Promise((resolve, reject) => { observer.on('message', message => { if (message.kind !== 'ready') resolve(message); }); observer.once('error', reject); });
  await ready;
  const lock = await acquireWorkerLock(root, {});
  t.after(() => lock.release());
  const result = await observed;
  assert.equal(result.kind, 'complete', JSON.stringify(result));
  assert.equal(result.pid, process.pid);
  assert.deepEqual(await readdir(root), ['worker.lock']);
});
