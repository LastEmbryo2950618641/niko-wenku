import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLibrary } from '../server/library.mjs';
import { createNetwork } from '../server/network.mjs';
import { loadDownloadQueue, readJsonFile, writeJsonAtomic } from '../server/download-queue.mjs';
import { backfillBookCover } from '../server/cover-backfill.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
let network;
try {
  const { values } = parseArgs({ options: { queue: { type: 'string' }, library: { type: 'string' }, 'state-dir': { type: 'string' } } });
  const stateDir = resolve(values['state-dir'] || join(project, '.state'));
  let lock;
  try { lock = await readJsonFile(join(stateDir, 'worker.lock')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lock) {
    let running = false;
    try { process.kill(lock.pid, 0); running = true; } catch (error) { if (error.code === 'EPERM') running = true; }
    if (running) throw new Error('请先运行 download:stop，再补旧书封面，完成后用 download:start 继续扫描与下载');
  }
  const queue = await loadDownloadQueue(resolve(values.queue || join(project, 'download-queue.json')));
  const libraryRoot = resolve(values.library || join(project, 'library'));
  const books = (await createLibrary(libraryRoot).scan()).books.filter(book => !book.coverUrl && book.source?.coverUrl);
  network = await createNetwork({ proxy: queue.jobs[0]?.proxy || 'auto' });
  let lastRequestAt = 0;
  try { lastRequestAt = Date.parse((await readJsonFile(join(stateDir, 'worker-state.json'), 16 * 1024 * 1024)).lastRequestAt) || 0; } catch {}
  const results = [];
  for (const book of books) {
    controller.signal.throwIfAborted();
    const result = await backfillBookCover(join(libraryRoot, book.id), {
      dispatcher: network.dispatcher, signal: controller.signal,
      async beforeRequest() {
        const wait = lastRequestAt + queue.minDelayMs + Math.random() * (queue.maxDelayMs - queue.minDelayMs) - Date.now();
        if (wait > 0) await delay(wait, undefined, { signal: controller.signal });
        lastRequestAt = Date.now();
      }
    });
    results.push(result);
    await writeJsonAtomic(join(stateDir, 'cover-backfill-result.json'), { updatedAt: new Date().toISOString(), total: books.length, results });
    console.log((result.status === 'downloaded' ? '已补齐封面：' : '封面暂不可用：') + book.id);
    if (result.code === 429 || (result.code === 503 && result.retryAfterMs > 0)) {
      const state = await readJsonFile(join(stateDir, 'worker-state.json'), 16 * 1024 * 1024);
      state.cooldownUntil = new Date(Date.now() + Math.max(queue.retryMs, result.retryAfterMs || 0)).toISOString();
      await writeJsonAtomic(join(stateDir, 'worker-state.json'), state);
      console.log('图片服务器要求限速，已保存冷却时间并停止补图。');
      break;
    }
  }
  if (lastRequestAt) {
    try {
      const state = await readJsonFile(join(stateDir, 'worker-state.json'), 16 * 1024 * 1024);
      state.lastRequestAt = new Date(lastRequestAt).toISOString();
      await writeJsonAtomic(join(stateDir, 'worker-state.json'), state);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log('封面补齐完成：' + results.filter(result => result.status === 'downloaded').length + '/' + books.length);
} catch (error) {
  console.error(controller.signal.aborted ? '补封面已停止，原正文保持完整。' : error.message);
  process.exitCode = 1;
} finally { await network?.dispatcher.close(); }
