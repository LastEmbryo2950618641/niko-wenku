import { setTimeout as delay } from 'node:timers/promises';
import { ArchiveError } from './library.mjs';

function imageExtension(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) return 'jpg';
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND') return 'png';
  if (buffer.length >= 14 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) && buffer.at(-1) === 0x3b) return 'gif';
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) return 'webp';
  throw new ArchiveError('封面不是有效的 JPEG、PNG、GIF 或 WebP 图片', 415);
}

/** Fetch only a public image. Account cookies are never sent to image hosts. */
export async function downloadCoverImage(inputUrl, options = {}) {
  let url = new URL(inputUrl);
  const maxBytes = options.maxCoverBytes ?? 8 * 1024 * 1024;
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ArchiveError('封面地址必须为不含密码的 HTTP(S) 地址');
    if (options.beforeRequest) await options.beforeRequest();
    else {
      const min = options.minDelayMs ?? 3000, max = options.maxDelayMs ?? 8000;
      await delay(min + Math.random() * Math.max(0, max - min), undefined, { signal: options.signal });
    }
    options.signal?.throwIfAborted();
    const headers = { 'User-Agent': 'LocalBookArchive/0.1', Accept: 'image/jpeg,image/png,image/webp,image/gif' };
    if (options.referer) {
      const referer = new URL(options.referer);
      if (['http:', 'https:'].includes(referer.protocol) && !referer.username && !referer.password) headers.Referer = referer.href;
    }
    const response = await fetch(url, { headers, dispatcher: options.dispatcher, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(options.coverTimeoutMs ?? 20000), ...(options.signal ? [options.signal] : [])]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirect === 5) throw new ArchiveError('封面重定向过多或地址缺失');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      const error = new ArchiveError('封面服务器返回 HTTP ' + response.status, response.status);
      error.retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()) : 0;
      throw error;
    }
    if (/text\/html|application\/(?:xhtml|json)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new ArchiveError('封面返回非图片页面', 415);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new ArchiveError('封面超过体积限制', 413);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new ArchiveError('封面超过体积限制', 413);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return { buffer, name: 'cover.' + imageExtension(buffer), bytes: buffer.length };
  }
}

export function coverFailure(error) {
  return { status: [404, 410].includes(error.status) ? 'missing' : 'failed', code: error.status || error.code || 'COVER_FAILED', retryAfterMs: Math.min(86400000, Math.max(0, Number(error.retryAfterMs) || 0)) };
}
