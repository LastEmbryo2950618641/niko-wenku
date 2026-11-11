#!/usr/bin/env node
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createLibrary } from '../server/library.mjs';

const defaultSite = 'http://111.229.32.85';
const validId = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
const help = `用法：nikowenku-archive <command> [options]

命令：
  search <keyword>       搜索书名、作者、简介或标签
  info <book-id>         查看书籍详情
  download <book-id>     将书库中的完整正文保存到本地文件

选项：
  --library <path>       书库目录，默认 ARCHIVE_LIBRARY 或当前目录下的 library
  --state-dir <path>     索引目录，默认 ARCHIVE_STATE_DIR 或当前目录下的 .state
  --site <url>           书库网站地址，默认 ${defaultSite}，或 ARCHIVE_SITE_URL
  --local                使用本地书库目录
  --limit <number>       搜索返回条数，默认 20，最多 100
  --output <path>        保存路径，默认当前目录下的 <book-id>.<原扩展名>
  --force                允许替换已存在的输出文件
  --json                 以 JSON 输出结果
  --help                 显示帮助

示例：
  nikowenku-archive search 星
  nikowenku-archive info wenku8-934
  nikowenku-archive download wenku8-934 --output ./雾岛来信.txt`;

function printBook(book) {
  return {
    id: book.id,
    title: book.title,
    originalTitle: book.originalTitle || undefined,
    author: book.author,
    category: book.category,
    status: book.status,
    language: book.language,
    updatedAt: book.updatedAt,
    wordCount: book.wordCount,
    chapterCount: book.chapterCount,
    description: book.description,
    tags: book.tags,
    source: book.source?.name ? { name: book.source.name, id: book.source.id, updatedAt: book.source.updatedAt } : undefined
  };
}

async function exportText(source, destination, force) {
  let existing;
  try { existing = await stat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && existing.dev === source.info.dev && existing.ino === source.info.ino) {
    throw new Error('输出路径不能指向书库中的原始正文，请选择其他路径');
  }
  if (existing && !force) throw new Error('输出文件已存在，请更换 --output 路径，或加 --force 替换');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), '.nikowenku-download-' + randomUUID() + '.part');
  try {
    await copyFile(source.path, temporary, constants.COPYFILE_EXCL);
    if (force) await rename(temporary, destination);
    else await link(temporary, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('输出文件已存在，请更换 --output 路径，或加 --force 替换');
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

async function exportRemote(response, destination, force) {
  let temporary;
  try {
    let existing;
    try { existing = await stat(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !force) throw new Error('输出文件已存在，请更换 --output 路径，或加 --force 替换');
    await mkdir(dirname(destination), { recursive: true });
    temporary = join(dirname(destination), '.nikowenku-download-' + randomUUID() + '.part');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (force) await rename(temporary, destination);
    else await link(temporary, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('输出文件已存在，请更换 --output 路径，或加 --force 替换');
    throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

function normalizeSite(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('--site 必须是完整的 http:// 或 https:// 网站地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('--site 必须是无账号密码的 HTTP 或 HTTPS 网站地址');
  }
  url.hash = ''; url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function siteUrl(base, path) {
  return new URL(path.replace(/^\//, ''), base);
}

async function request(url, timeoutMs = 30000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.ok) return response;
  let message = `${response.status} ${response.statusText}`;
  try { message = (await response.json()).error || message; } catch {}
  throw new Error(`书库请求失败：${message}`);
}

async function requestJson(url) {
  const response = await request(url);
  return response.json();
}

async function remoteSearch(site, query, limit) {
  const pageSize = Math.min(limit, 48);
  const books = [];
  let total = 0;
  for (let page = 1; books.length < limit; page++) {
    const params = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize), sort: 'title' });
    const result = await requestJson(siteUrl(site, '/api/library?' + params));
    if (!Array.isArray(result.books) || !Number.isInteger(result.total)) throw new Error('网站返回了无效的书目数据');
    total = result.total;
    books.push(...result.books);
    if (!result.books.length || books.length >= total) break;
  }
  return { books: books.slice(0, limit), total };
}

function downloadedName(response, id) {
  const header = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(header)?.[1];
  let name = plain || '';
  try { if (encoded) name = decodeURIComponent(encoded); } catch {}
  const extension = extname(name).toLowerCase();
  return id + (['.txt', '.md', '.text'].includes(extension) ? extension : '.txt');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      library: { type: 'string' }, 'state-dir': { type: 'string' },
      site: { type: 'string' }, local: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' }, output: { type: 'string' },
      force: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  });
  if (values.help || !positionals.length || positionals[0] === 'help') {
    console.log(help);
    return;
  }

  const [command, ...args] = positionals;
  if (!['search', 'info', 'download'].includes(command)) throw new Error(`未知命令：${command}\n\n${help}`);
  if (values.site && (values.local || values.library)) throw new Error('--site 不能与 --local 或 --library 同时使用');
  const local = !values.site && (values.local || Boolean(values.library || process.env.ARCHIVE_LIBRARY));
  const remoteSite = local ? null : normalizeSite(values.site || process.env.ARCHIVE_SITE_URL || defaultSite);
  if (command !== 'search' && args.length === 1 && !validId.test(args[0])) throw new Error('书籍 ID 格式无效');
  const library = local ? createLibrary(
    resolve(values.library || process.env.ARCHIVE_LIBRARY || join(process.cwd(), 'library')),
    { indexPath: join(resolve(values['state-dir'] || process.env.ARCHIVE_STATE_DIR || join(process.cwd(), '.state')), 'library-index.json') }
  ) : null;

  if (command === 'search') {
    const query = args.join(' ').trim();
    if (!query) throw new Error('用法：nikowenku-archive search <keyword> [--limit 20]');
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit 必须是 1 到 100 之间的整数');
    let result;
    if (local) {
      await library.scan({ waitForRefresh: true });
      result = library.list({ query, page: 1, pageSize: limit, sort: 'title' });
    } else {
      result = await remoteSearch(remoteSite, query, limit);
    }
    if (values.json) {
      console.log(JSON.stringify({ query, total: result.total, books: result.books.map(printBook) }, null, 2));
    } else if (!result.total) {
      console.log('没有找到匹配的书籍。');
    } else {
      console.log(`找到 ${result.total} 本书${result.total > limit ? `，显示前 ${limit} 本` : ''}：`);
      for (const book of result.books) console.log(`${book.id}\t${book.title}\t${book.author}`);
    }
    return;
  }

  if (command === 'info') {
    if (args.length !== 1) throw new Error('用法：nikowenku-archive info <book-id> [--json]');
    const book = local ? await library.detail(args[0]) : await requestJson(siteUrl(remoteSite, '/api/books/' + encodeURIComponent(args[0])));
    if (values.json) {
      console.log(JSON.stringify(book, null, 2));
    } else {
      console.log(`${book.title} (${book.id})`);
      console.log(`作者：${book.author}`);
      console.log(`分类：${book.category} · 状态：${book.status} · 语言：${book.language}`);
      if (book.updatedAt) console.log(`更新时间：${book.updatedAt}`);
      if (book.wordCount) console.log(`字数：${book.wordCount.toLocaleString('zh-CN')}`);
      console.log(`章节：${book.chapterCount} · 正文：${book.files.find(file => file.kind === 'text')?.bytes.toLocaleString('zh-CN') || 0} bytes`);
      if (book.tags.length) console.log(`标签：${book.tags.join('、')}`);
      if (book.description) console.log(`简介：${book.description}`);
    }
    return;
  }

  if (command === 'download') {
    if (args.length !== 1) throw new Error('用法：nikowenku-archive download <book-id> [--output <path>] [--force]');
    const id = args[0];
    let destination, bytes;
    if (local) {
      const source = await library.file(id, 'text');
      destination = resolve(values.output || join(process.cwd(), id + (extname(source.name) || '.txt')));
      await exportText(source, destination, values.force);
      bytes = source.info.size;
    } else {
      const response = await request(siteUrl(remoteSite, '/api/books/' + encodeURIComponent(id) + '/files/text'), 600000);
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('网站未返回正文文件，请检查书库地址或书籍 ID');
      }
      const name = downloadedName(response, id);
      destination = resolve(values.output || join(process.cwd(), name));
      await exportRemote(response, destination, values.force);
      bytes = (await stat(destination)).size;
    }
    const result = { id, output: destination, bytes };
    console.log(values.json ? JSON.stringify(result, null, 2) : `已下载：${destination} (${bytes.toLocaleString('zh-CN')} bytes)`);
    return;
  }

}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
