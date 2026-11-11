import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadFullBook } from '../server/downloader.mjs';
import { createLibrary } from '../server/library.mjs';
import { languageLabel } from '../shared/language.mjs';
import { createNetwork } from '../server/network.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let network;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, cookies: { type: 'string' }, library: { type: 'string' },
    'min-delay': { type: 'string', default: '3' }, 'max-delay': { type: 'string', default: '8' },
    attempts: { type: 'string', default: '3' }, proxy: { type: 'string', default: 'auto' }, 'state-dir': { type: 'string' }
  } });
  if (!positionals[0]) throw new Error('用法：npm run download:full -- queue.json [--cookies secrets/cookies.json] [--min-delay 3 --max-delay 8]');
  const input = JSON.parse((await readFile(resolve(positionals[0]), 'utf8')).replace(/^\uFEFF/, ''));
  const queue = Array.isArray(input) ? input : [input];
  const min = Number(values['min-delay']), max = Number(values['max-delay']), attempts = Number(values.attempts);
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max) || max < min || !Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('间隔或重试参数不合法');
  network = await createNetwork({ proxy: values.proxy });
  console.log('网络配置：' + network.label);
  const options = { signal: controller.signal, dispatcher: network.dispatcher, minDelayMs: min * 1000, maxDelayMs: max * 1000 };
  if (values.cookies) {
    const secret = (await readFile(resolve(values.cookies), 'utf8')).trim();
    try {
      const parsed = JSON.parse(secret);
      options.cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
      if (!Array.isArray(options.cookies)) throw new Error('缺少 cookies 数组');
    } catch (error) {
      if (secret.startsWith('{') || secret.startsWith('[')) throw new Error('Cookie JSON 格式不正确');
      options.rawCookie = secret.replace(/^Cookie:\s*/i, '');
    }
  }
  const libraryRoot = resolve(values.library || join(project, 'library'));
  const stateDir = resolve(values['state-dir'] || join(project, '.state'));
  await mkdir(stateDir, { recursive: true });
  const statePath = join(stateDir, 'download-state.json');
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}
  async function saveState() {
    await writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
    await rename(statePath + '.tmp', statePath);
  }
  const existing = new Set((await createLibrary(libraryRoot).scan()).books.map(book => book.id));
  let requests = 0, failed = 0;
  for (const book of queue) {
    if (controller.signal.aborted) break;
    if (existing.has(book.id)) { console.log('跳过已上架：' + book.id); continue; }
    let completed = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (requests++) await delay((min + Math.random() * (max - min)) * 1000, undefined, { signal: controller.signal });
      try {
        const receipt = await downloadFullBook(libraryRoot, book, values.url, options);
        state[book.id] = { status: 'published', language: receipt.language, encoding: receipt.encoding, bytes: receipt.bytes, sha256: receipt.sha256, completedAt: new Date().toISOString() };
        await saveState();
        existing.add(book.id);
        console.log('已上架：' + book.title + '（' + languageLabel(receipt.language) + '，' + receipt.bytes + ' bytes）');
        completed = true;
        break;
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error('下载失败：' + book.id + '，第 ' + attempt + '/' + attempts + ' 次');
        if ([401, 403, 400].includes(error.status) || /HTML|登录|Cookie|SHA-256/.test(error.message)) {
          console.error('请检查登录态、下载入口和文件校验；该任务已停止，不会把错误页发布成书。');
          break;
        }
        if (error.retryAfterMs > 0 && attempt < attempts) await delay(Math.min(error.retryAfterMs, 300000), undefined, { signal: controller.signal });
      }
    }
    if (!completed) {
      failed++;
      state[book.id] = { status: controller.signal.aborted ? 'cancelled' : 'failed', updatedAt: new Date().toISOString() };
      await saveState();
    }
  }
  if (failed || controller.signal.aborted) process.exitCode = 1;
} catch (error) {
  console.error(controller.signal.aborted ? '任务已停止。再次运行会跳过已上架书籍。' : error.message);
  process.exitCode = 1;
} finally { await network?.dispatcher.close(); }
