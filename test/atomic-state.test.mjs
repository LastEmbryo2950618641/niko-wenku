import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonAtomic } from '../server/download-queue.mjs';

async function lockedFile(t, milliseconds) {
  const root = await mkdtemp(join(tmpdir(), 'wenku-state-lock-'));
  const path = join(root, 'state.json');
  await writeFile(path, JSON.stringify({ completed: 461, nextId: 462 }));
  const literal = path.replaceAll("'", "''");
  const code = "$f=[IO.File]::Open('" + literal + "',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Threading.Thread]::Sleep(" + milliseconds + ") } finally { $f.Dispose() }";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('文件锁辅助进程失败'))); });
  t.after(async () => { await finished; await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', data => { output += data; if (output.includes('ready')) resolve(); });
    child.once('error', reject);
    child.once('exit', () => { if (!output.includes('ready')) reject(new Error('未能取得测试文件锁')); });
  });
  return { root, path, finished };
}

test('atomic state writes survive a brief Windows read handle without resetting the checkpoint', { skip: process.platform !== 'win32', timeout: 8000 }, async t => {
  const f = await lockedFile(t, 500);
  await writeJsonAtomic(f.path, { completed: 462, nextId: 463 });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { completed: 462, nextId: 463 });
  assert.deepEqual(await readdir(f.root), ['state.json']);
});

test('a persistent Windows lock fails within a bound while preserving the original state', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const f = await lockedFile(t, 3000);
  await assert.rejects(() => writeJsonAtomic(f.path, { completed: 0 }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { completed: 461, nextId: 462 });
  assert.deepEqual(await readdir(f.root), ['state.json']);
});
