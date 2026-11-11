import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { publishBundle, ArchiveError } from './library.mjs';
import { decodeBook } from './text.mjs';
import { languageRank } from '../shared/language.mjs';
import { downloadCoverImage, coverFailure } from './cover.mjs';

function fullBookCandidates(input, overrideUrl) {
  if (overrideUrl) return [{ url: overrideUrl, language: input.language, encoding: input.encoding, integrity: input.integrity }];
  if (input.downloadVariants !== undefined && !Array.isArray(input.downloadVariants)) throw new ArchiveError('downloadVariants 必须是全文版本数组');
  const variants = [...(input.downloadVariants || [])];
  if (input.downloadUrl) variants.push({ url: input.downloadUrl, language: input.language, encoding: input.encoding, integrity: input.integrity });
  const candidates = variants.filter(item => item && typeof item.url === 'string' && item.url.trim());
  if (!candidates.length) throw new ArchiveError('请提供 downloadUrl 或 downloadVariants 中的完整 TXT 下载入口');
  const seen = new Set();
  return candidates.sort((a, b) => languageRank(a.language) - languageRank(b.language)).filter(chosen => {
    if (seen.has(chosen.url)) return false;
    seen.add(chosen.url);
    return true;
  }).map(chosen => {
    if (chosen.language !== undefined && typeof chosen.language !== 'string') throw new ArchiveError('全文版本的 language 必须是文本');
    if (chosen.encoding !== undefined && typeof chosen.encoding !== 'string') throw new ArchiveError('全文版本的 encoding 必须是文本');
    return { url: chosen.url, language: chosen.language || 'und', encoding: chosen.encoding || 'auto', integrity: chosen.integrity };
  });
}
export function selectFullBookDownload(input, overrideUrl) { return fullBookCandidates(input, overrideUrl)[0]; }

export function cookieHeaderFor(input, cookies = []) {
  const url = new URL(input);
  return cookies.filter(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const host = url.hostname.toLowerCase();
    const domainMatches = host === domain || (String(cookie.domain).startsWith('.') && host.endsWith('.' + domain));
    const path = cookie.path || '/';
    const pathMatches = url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/'));
    return domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:') && (!cookie.expires || cookie.expires === -1 || cookie.expires > Date.now() / 1000);
  }).map(cookie => {
    if (!/^[!#$%&'*+\-.^_~0-9A-Za-z]+$/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) throw new ArchiveError('Cookie 格式不合法');
    return cookie.name + '=' + cookie.value;
  }).join('; ');
}
export async function downloadFullBook(root, input, inputUrl, options = {}) {
  const candidates = fullBookCandidates(input, inputUrl);
  for (let index = 0; index < candidates.length; index++) {
    try { return await downloadSelectedBook(root, input, candidates[index], options); }
    catch (error) {
      if (![404, 410].includes(error.status) || index === candidates.length - 1) throw error;
      if (!options.beforeRequest) {
        const min = options.minDelayMs ?? 3000, max = options.maxDelayMs ?? 8000;
        await delay(min + Math.random() * Math.max(0, max - min), undefined, { signal: options.signal });
      }
    }
  }
}
async function downloadSelectedBook(root, input, selected, options) {
  input = { ...input, language: selected.language, encoding: selected.encoding, integrity: selected.integrity };
  let url = new URL(selected.url);
  const originalOrigin = url.origin;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let response;
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ArchiveError('下载地址必须是 HTTP(S)，不能在 URL 中夹带密码');
    const headers = { 'User-Agent': 'LocalBookArchive/0.1', Accept: 'text/plain,application/octet-stream;q=0.9,*/*;q=0.1' };
    const cookie = options.rawCookie ? url.origin === originalOrigin ? options.rawCookie : '' : cookieHeaderFor(url, options.cookies);
    if (cookie) {
      if (/[\r\n]/.test(cookie)) throw new ArchiveError('Cookie 不能包含换行');
      headers.Cookie = cookie;
    }
    await options.beforeRequest?.();
    options.signal?.throwIfAborted();
    response = await fetch(url, { headers, dispatcher: options.dispatcher, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 60000), ...(options.signal ? [options.signal] : [])]) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirect === 5) throw new ArchiveError('下载重定向过多或地址缺失');
    url = new URL(location, url);
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    const error = new ArchiveError('下载服务器返回 HTTP ' + response.status, response.status);
    error.retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()) : 0;
    throw error;
  }
  if (/text\/html|application\/(?:xhtml|json)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new ArchiveError('下载地址返回 HTML/登录验证页，未当作正文发布');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ArchiveError('下载文件超出体积限制', 413);
  }
  const chunks = [];
  let size = 0;
  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = contentLength > 0 && !response.headers.get('content-encoding') ? contentLength : null;
  let lastProgressAt = 0;
  await options.onProgress?.({ phase: 'text', receivedBytes: 0, totalBytes });
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new ArchiveError('下载文件超出体积限制', 413);
    chunks.push(chunk);
    if (Date.now() - lastProgressAt >= 1000) {
      lastProgressAt = Date.now();
      await options.onProgress?.({ phase: 'text', receivedBytes: size, totalBytes });
    }
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new ArchiveError('服务器返回空文件');
  await options.onProgress?.({ phase: 'validating', receivedBytes: size, totalBytes: size });
  const decoded = decodeBook(buffer, input.encoding || 'auto');
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(decoded.text)) throw new ArchiveError('文件实际为 HTML 登录或验证页面');
  if (input.integrity?.sha256 && input.integrity.sha256.toLowerCase() !== createHash('sha256').update(buffer).digest('hex')) throw new ArchiveError('文件 SHA-256 校验不匹配，未发布');
  const manifest = structuredClone(input);
  for (const key of ['downloadUrl', 'downloadVariants', 'cookies', 'cookie', 'session', 'headers', 'password', 'authorization']) delete manifest[key];
  manifest.files = { text: 'content.txt' };
  manifest.encoding = decoded.encoding;
  manifest.downloadedAt = new Date().toISOString();
  const buffers = { 'content.txt': buffer };
  let cover;
  if (options.downloadCovers !== false && manifest.source?.coverUrl) {
    await options.onProgress?.({ phase: 'cover', receivedBytes: size, totalBytes: size });
    try {
      const image = await downloadCoverImage(manifest.source.coverUrl, { ...options, referer: manifest.source.url });
      manifest.files.cover = image.name;
      buffers[image.name] = image.buffer;
      cover = { status: 'downloaded', bytes: image.bytes };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      cover = coverFailure(error);
    }
    manifest.coverDownload = { ...cover, checkedAt: new Date().toISOString() };
  }
  options.signal?.throwIfAborted();
  await options.onProgress?.({ phase: 'publishing', receivedBytes: size, totalBytes: size });
  const receipt = await publishBundle(root, manifest, buffers, { replaceExisting: options.replaceExisting === true });
  return { ...receipt, language: selected.language || 'und', encoding: decoded.encoding, ...(cover ? { cover } : {}) };
}
