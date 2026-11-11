import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { normalizeWenkuBook, parseWenkuInfo, parseWenkuDownloads, fetchWenkuPage } from '../server/wenku8.mjs';
import { selectFullBookDownload } from '../server/downloader.mjs';
import { createLibrary } from '../server/library.mjs';
import { decodeBook } from '../server/text.mjs';
import { languageLabel } from '../shared/language.mjs';
import { createNetwork } from '../server/network.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let network;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cookies: { type: 'string' }, html: { type: 'string' }, 'downloads-html': { type: 'string' },
    output: { type: 'string' }, library: { type: 'string' }, download: { type: 'boolean', default: false },
    'min-delay': { type: 'string', default: '3' }, 'max-delay': { type: 'string', default: '8' }, proxy: { type: 'string', default: 'auto' }, 'state-dir': { type: 'string' }
  } });
  if (positionals.length !== 1) throw new Error('用法：npm run source:wenku8 -- 书籍编号或网址 [--cookies 本地文件] [--download] [--html 资料页.html --downloads-html 全本页.html]');
  const source = normalizeWenkuBook(positionals[0]);
  const min = Number(values['min-delay']), max = Number(values['max-delay']);
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max) || max < min) throw new Error('等待间隔不合法');
  const pause = () => delay((min + Math.random() * (max - min)) * 1000, undefined, { signal: controller.signal });
  const libraryRoot = resolve(values.library || join(project, 'library'));
  if (values.download && (await createLibrary(libraryRoot).scan()).books.some(book => book.id === 'wenku8-' + source.id)) {
    console.log('跳过已上架：wenku8-' + source.id + '。每本书只保留已下载的一个版本。');
  } else {
    if (!values.html || !values['downloads-html'] || values.download) {
      network = await createNetwork({ proxy: values.proxy });
      console.log('网络配置：' + network.label);
    }
    const options = { signal: controller.signal, dispatcher: network?.dispatcher };
    if (values.cookies) {
      const secret = (await readFile(resolve(values.cookies), 'utf8')).replace(/^\uFEFF/, '').trim();
      if (secret.startsWith('{') || secret.startsWith('[')) {
        let parsed;
        try { parsed = JSON.parse(secret); } catch { throw new Error('Cookie JSON 格式不正确'); }
        options.cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
        if (!Array.isArray(options.cookies)) throw new Error('Cookie 文件缺少 cookies 数组');
      } else options.rawCookie = secret.replace(/^Cookie:\s*/i, '');
    }
    console.log('正在整理书籍资料：' + source.id);
    const infoHtml = values.html ? decodeBook(await readFile(resolve(values.html))).text : await fetchWenkuPage(source.infoUrl, options);
    const book = parseWenkuInfo(infoHtml, source.id);
    const output = resolve(values.output || join(project, '.state', 'prepared', book.id + '.json'));
    async function save() {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output + '.tmp', JSON.stringify(book, null, 2) + '\n');
      await rename(output + '.tmp', output);
    }
    await save();
    console.log('已保存资料：' + output);
    if (!book.source.downloadPageUrl) throw new Error('资料页未展示 TXT 全本入口，已保存元数据；不会猜测或逐章抓取');
    if (!values['downloads-html'] || values.download) await pause();
    const downloadHtml = values['downloads-html'] ? decodeBook(await readFile(resolve(values['downloads-html']))).text : await fetchWenkuPage(book.source.downloadPageUrl, options);
    book.downloadVariants = parseWenkuDownloads(downloadHtml, source.id);
    const selected = selectFullBookDownload(book);
    book.language = selected.language;
    book.encoding = selected.encoding;
    await save();
    console.log('只选一个全文版本：' + languageLabel(selected.language) + '，' + selected.encoding + '。');
    if (!values.download) console.log('资料与下载入口已就绪。加 --download 可下载该单一版本并直接上架。');
    else {
      await pause();
      const args = [join(project, 'scripts', 'download-full.mjs'), output, '--library', libraryRoot, '--min-delay', String(min), '--max-delay', String(max), '--proxy', values.proxy, '--attempts', '1'];
      if (values['state-dir']) args.push('--state-dir', resolve(values['state-dir']));
      if (values.cookies) args.push('--cookies', resolve(values.cookies));
      const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, signal: controller.signal });
      const exitCode = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('exit', code => resolveExit(code ?? 1)); });
      if (exitCode !== 0) process.exitCode = exitCode;
      else console.log('已完成下载与发布，书库页面会自动发现该书。');
    }
  }
} catch (error) {
  console.error(controller.signal.aborted ? '任务已停止。' : error.message);
  process.exitCode = 1;
} finally { await network?.dispatcher.close(); }
