import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = resolve('scripts/watch-library.mjs');

test('CLI reports worker status and stops a real background worker through its control file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wenku-worker-cli-'));
  const queue = join(root, 'queue.json'), library = join(root, 'library'), stateDir = join(root, 'state');
  const common = ['--queue', queue, '--library', library, '--state-dir', stateDir];
  await writeFile(queue, JSON.stringify({ books: [], pollSeconds: 0.03, proxy: 'direct' }));
  t.after(async () => {
    await exec(process.execPath, [script, ...common, '--stop'], { windowsHide: true, timeout: 15000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const started = await exec(process.execPath, [script, ...common, '--background'], { windowsHide: true, timeout: 10000 });
  assert.match(started.stdout, /已启动/);
  const status = JSON.parse((await exec(process.execPath, [script, ...common, '--status'])).stdout);
  assert.equal(status.running, true);
  assert.equal(status.queuePath, queue);
  await assert.rejects(() => exec(process.execPath, [script, ...common, '--once']), /运行/);
  const stop = await exec(process.execPath, [script, ...common, '--stop'], { timeout: 15000 });
  assert.match(stop.stdout, /停止/);
  const final = JSON.parse((await exec(process.execPath, [script, ...common, '--status'])).stdout);
  assert.equal(final.running, false);
  assert.equal(final.status, 'stopped');
  assert.equal(JSON.parse(await readFile(join(stateDir, 'worker-state.json'), 'utf8')).running, false);
});
