import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from '../server/app.mjs';

const exec = promisify(execFile);
async function fixture(t, queue = { books: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-worker-api-'));
  const worker = { queuePath: join(root, 'queue.json'), stateDir: join(root, 'state'), libraryRoot: join(root, 'library') };
  await mkdir(worker.stateDir);
  await writeFile(worker.queuePath, JSON.stringify({ proxy: 'direct', pollSeconds: 0.03, minDelaySeconds: 0, maxDelaySeconds: 0, ...queue }));
  const server = await createAppServer({ libraryRoot: worker.libraryRoot, webRoot: join(root, 'web'), worker });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try {
      const lock = JSON.parse(await readFile(join(worker.stateDir, 'worker.lock'), 'utf8'));
      if (lock.pid !== process.pid) await exec(process.execPath, [resolve('scripts/watch-library.mjs'), '--queue', worker.queuePath, '--library', worker.libraryRoot, '--state-dir', worker.stateDir, '--stop'], { windowsHide: true, timeout: 15000 }).catch(() => {});
    } catch {}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { root, worker, origin, post: (action, payload = {}, overrides = {}) => fetch(origin + '/api/worker/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web', Origin: origin, ...overrides }, body: JSON.stringify(payload) }) };
}
async function until(check, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  do { const value = await check(); if (value) return value; await delay(75); } while (Date.now() < until);
  throw new Error('后台状态未按预期更新');
}

test('worker status reports real checkpoints and byte progress without exposing cookies, lock tokens, or private paths', async t => {
  const f = await fixture(t, { ranges: [{ source: 'wenku8', startId: 1, endId: 100, mode: 'metadata' }], downloadDiscovered: true });
  await writeFile(join(f.worker.stateDir, 'worker.lock'), JSON.stringify({ pid: process.pid, token: 'never-expose-lock', queuePath: f.worker.queuePath, libraryRoot: f.worker.libraryRoot }));
  await writeFile(join(f.worker.stateDir, 'worker-state.json'), JSON.stringify({
    running: true, pid: process.pid, status: 'downloading', heartbeatAt: new Date().toISOString(), queuePath: 'never-expose-path',
    authRequired: { credentialRevision: 'never-expose-cookie' }, progress: { published: 2, discovered: 8, missing: 1, failed: 0 },
    scanCheckpoints: [{ source: 'wenku8', startId: 1, endId: 100, lastCompletedId: 11, nextId: 12 }],
    workers: { scan: { capacity: 1, status: 'scanning', activeBookIds: ['wenku8-12'], pending: 88, completed: 10 }, download: { capacity: 1, status: 'downloading', activeBookIds: ['wenku8-3'], pending: 7, completed: 2 } },
    books: { 'wenku8-12': { title: '扫描资料', password: 'never-expose-password' }, 'wenku8-3': { title: '原创书稿', transfer: { phase: 'text', receivedBytes: 500, totalBytes: 1000 } } }
  }));
  const response = await fetch(f.origin + '/api/worker/status');
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.running, true);
  assert.equal(status.scan.total, 100);
  assert.equal(status.scan.processed, 11);
  assert.equal(status.scan.nextId, 12);
  assert.equal(status.download.current[0].transfer.receivedBytes, 500);
  assert.equal(status.download.current[0].transfer.totalBytes, 1000);
  assert.equal(status.download.current[0].transfer.percent, 50);
  assert.doesNotMatch(JSON.stringify(status), /never-expose|credentialRevision|cookiesFile|fingerprint/);
});

test('same-origin buttons start one real worker, expose live transfer progress, stop safely, and resume without publishing partial text', { timeout: 40000 }, async t => {
  let requests = 0;
  const body = Buffer.from('第一章 开端\n用于网站启停验收的完整原创书稿。\n第二章 结束\n全书完。\n'.repeat(1000));
  const upstream = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length }); if (requests === 1) res.write(body.subarray(0, 4096)); else res.end(body); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { books: [{ manifest: { id: 'web-control', title: '网站启停原创验收', language: 'zh-Hans', downloadUrl: 'http://127.0.0.1:' + upstream.address().port + '/full.txt' } }] });
  t.after(async () => { await exec(process.execPath, [resolve('scripts/watch-library.mjs'), '--queue', f.worker.queuePath, '--library', f.worker.libraryRoot, '--state-dir', f.worker.stateDir, '--stop'], { windowsHide: true, timeout: 15000 }).catch(() => {}); });
  const starts = await Promise.all([f.post('start'), f.post('start')]);
  for (const response of starts) assert.equal(response.status, 200);
  const started = await Promise.all(starts.map(response => response.json()));
  assert.equal(started[0].pid, started[1].pid);
  const live = await until(async () => { const state = await (await fetch(f.origin + '/api/worker/status')).json(); return state.download?.current[0]?.transfer?.receivedBytes > 0 && state; });
  assert.equal(live.download.current[0].transfer.receivedBytes, 4096);
  assert.equal(live.download.current[0].transfer.totalBytes, body.length);
  assert.equal(requests, 1);
  const stoppedResponse = await f.post('stop');
  assert.equal(stoppedResponse.status, 200);
  assert.equal((await stoppedResponse.json()).running, false);
  assert.equal((await (await fetch(f.origin + '/api/library')).json()).books.length, 0);
  const resumed = await f.post('start');
  assert.equal(resumed.status, 200);
  await until(async () => (await (await fetch(f.origin + '/api/library')).json()).books.length === 1);
  assert.equal(await readFile(join(f.worker.libraryRoot, 'web-control', 'content.txt'), 'utf8'), body.toString());
  assert.equal(requests, 2);
  assert.equal((await (await f.post('stop')).json()).running, false);
});

test('worker controls reject cross-origin requests and arbitrary command or path parameters', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('start', {}, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.post('start', {}, { 'X-Archive-Client': '' })).status, 403);
  assert.equal((await f.post('start', { command: 'anything', stateDir: '/unrelated' })).status, 400);
  const state = await (await fetch(f.origin + '/api/worker/status')).json();
  assert.equal(state.running, false);
});
