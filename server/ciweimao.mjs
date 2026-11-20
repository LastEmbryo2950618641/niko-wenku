// Node implementation of the ciweimao-download Skill's public, free-reader flow.
import { createDecipheriv } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';
import { createNetwork } from './network.mjs';
import { createCiweimaoCookieStore } from './ciweimao-auth.mjs';

export const CIWEIMAO_CATEGORY = '刺猬猫免费章节';
const WEB = 'https://www.ciweimao.com', WAP = 'https://wap.ciweimao.com';
const hosts = new Set(['www.ciweimao.com', 'wap.ciweimao.com', 'ciweimao.com']);
export class CiweimaoError extends Error {
  constructor(message, code = 'CONTENT', status = 502) { super(message); this.code = code; this.status = status; }
}
export function ciweimaoId(value) {
  if (typeof value !== 'string' || value.length > 500) throw new CiweimaoError('请输入刺猬猫作品 ID 或官网作品链接', 'INPUT', 400);
  value = value.trim();
  if (/^[1-9]\d{0,11}$/.test(value)) return value;
  try {
    const url = new URL(value), match = /^\/(?:book|chapter-list)\/([1-9]\d{0,11})(?:\/book_detail)?\/?$/.exec(url.pathname);
    if (hosts.has(url.hostname) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && match) return match[1];
  } catch {}
  throw new CiweimaoError('请输入刺猬猫作品 ID 或官网作品链接', 'INPUT', 400);
}
export function parseCiweimaoSearch(html) {
  const $ = load(html), list = $('.rank-book-list');
  if (!list.length) throw new CiweimaoError('刺猬猫搜索页面结构变化或需要验证');
  const books = new Map();
  list.find('li[data-book-id]').each((_, el) => {
    const row = $(el), id = row.attr('data-book-id'), title = row.find('.tit a').text().trim();
    if (/^[1-9]\d{0,11}$/.test(id || '') && title) books.set(id, { id, title, author: row.find('a[href*="/reader/"]').first().text().trim(), url: `${WEB}/book/${id}` });
  });
  return [...books.values()];
}
export function parseCiweimaoBookList(html, page) {
  const $ = load(html), table = $('.book-list-table');
  if (!table.length) throw new CiweimaoError('书库页面不可读取或需要人工验证', 'ACCESS');
  const current = Number($('#curr_page').val());
  if (current !== page) throw new CiweimaoError('官网没有返回请求的书库页，扫描已暂停', 'ACCESS');
  const totalPages = Number($('.pagination .pageSkip i').text().trim());
  if (!Number.isSafeInteger(totalPages) || totalPages < page || totalPages > 1000000) throw new CiweimaoError('无法识别书库总页数');
  const books = new Map();
  table.find('tr').each((_, el) => {
    const row = $(el), a = row.find('.name a').first();
    if (!a.length) return;
    let id;
    try { id = ciweimaoId(a.attr('href')); } catch { return; }
    books.set(id, { id, title: a.text().trim(), author: row.find('.author').text().trim(), url: `${WEB}/book/${id}` });
  });
  if (!books.size) throw new CiweimaoError('书库页没有可识别的作品，保留扫描断点');
  const gate = /page\s*>=\s*(\d+)\s*&&\s*!HB\.util\.Cookie\.get\(['"]booklistCode['"]\)/.exec(html);
  return { books: [...books.values()], page, totalPages, verificationPage: gate ? Number(gate[1]) : null };
}
export function parseCiweimaoCatalog(html, id) {
  const $ = load(html), title = $('.book-info h1.book').text().trim(), catalog = $('.catalogue');
  if (!title || !catalog.length) throw new CiweimaoError('作品不存在、已下架或目录结构变化');
  const chapters = [], seen = new Set();
  catalog.find('ul.catalogue-list').each((_, el) => {
    const volume = $(el).prevAll('h2').first().text().trim();
    $(el).find('li a[href*="/chapter/"]').each((_, anchor) => {
      const link = $(anchor), match = /^\/chapter\/(\d+)\/?$/.exec(new URL(link.attr('href'), WAP).pathname);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);
      chapters.push({ id: match[1], title: link.text().trim(), volume, index: chapters.length + 1, free: !link.find('.icon-lock').length });
    });
  });
  if (!chapters.length) throw new CiweimaoError('目录中没有可识别的章节');
  return {
    id, title, author: $('.book-info .author').text().trim().split(' 著')[0],
    description: $('.book-desc .desc-cnt').text().trim(),
    status: /已完结|已完結/.test($('.book-info .intro').text()) ? '已完结（免费章节）' : '连载中（免费章节）',
    url: `${WEB}/book/${id}`, chapters
  };
}
export function decodeCiweimaoContent(content, keys, accessKey) {
  if (typeof content !== 'string' || !content || !Array.isArray(keys) || !keys.length || typeof accessKey !== 'string' || !accessKey) throw new CiweimaoError('免费正文缺少解码参数');
  try {
    for (const index of [accessKey.charCodeAt(accessKey.length - 1) % keys.length, accessKey.charCodeAt(0) % keys.length]) {
      const raw = Buffer.from(content, 'base64'), key = Buffer.from(keys[index], 'base64');
      if (![16, 24, 32].includes(key.length) || raw.length < 32 || raw.length % 16) throw new Error('Invalid cipher');
      const cipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, raw.subarray(0, 16));
      content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(raw.subarray(16)), cipher.final()]));
    }
    return content;
  } catch { throw new CiweimaoError('免费正文解码失败，官网格式可能已变化'); }
}
export function cleanCiweimaoContent(html) {
  const $ = load(html), paragraphs = $('p.chapter');
  if (!paragraphs.length) throw new CiweimaoError('未识别到免费章节完整正文');
  $('script, style, .watermark, .num-link, .chapter-comment-wrap').remove();
  const lines = [];
  paragraphs.each((_, el) => {
    const p = $(el);
    p.find('span').each((_, span) => { if (!Object.keys(span.attribs || {}).length && /^[A-Za-z0-9]{4,16}$/.test($(span).text())) $(span).remove(); });
    p.find('br').replaceWith('\n');
    p.find('img').each((_, img) => { const src = $(img).attr('data-original') || $(img).attr('src'); $(img).replaceWith($('<span>').text(src ? `[插图：${src}]` : '[插图]')); });
    const line = p.text().trim();
    if (line) lines.push(line);
  });
  if (!lines.length) throw new CiweimaoError('免费章节正文为空');
  return lines.join('\n\n');
}

export async function createCiweimaoClient({ signal, delayMs = 1500, fetchImpl = fetch, proxy = 'auto', cookieFile } = {}) {
  const network = await createNetwork({ proxy });
  const cookieStore = cookieFile ? await createCiweimaoCookieStore(cookieFile) : null;
  const cookies = new Map();
  let lastRequest = 0, requestGate = Promise.resolve(), verificationPage = null, checkedListGate = false;
  function waitForRequest() {
    const next = requestGate.then(async () => {
      await delay(Math.max(0, delayMs - (Date.now() - lastRequest)), undefined, { signal });
      signal?.throwIfAborted();
      lastRequest = Date.now();
    });
    requestGate = next.catch(() => {});
    return next;
  }
  async function request(path, { method = 'GET', data, referer } = {}) {
    let url = new URL(path), redirects = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!hosts.has(url.hostname) || url.protocol !== 'https:' || url.port) throw new CiweimaoError('官网跳转到不受支持的地址');
      await waitForRequest();
      if (cookieStore) await cookieStore.refresh();
      let response;
      const timeout = AbortSignal.timeout(30000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        response = await fetchImpl(url, { method, signal: combined, dispatcher: network.dispatcher, redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            ...(cookieStore ? (cookieStore.header(url.hostname, url.pathname) ? { Cookie: cookieStore.header(url.hostname, url.pathname) } : {}) : cookies.has(url.hostname) ? { Cookie: [...cookies.get(url.hostname).values()].join('; ') } : {}),
            ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}),
            ...(referer ? { Referer: referer } : {}) },
          ...(data ? { body: new URLSearchParams(data) } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt < 2) continue;
        throw new CiweimaoError('刺猬猫网络请求失败，请稍后重试', 'NETWORK');
      }
      for (const cookie of response.headers.getSetCookie?.() || []) {
        const pair = cookie.split(';')[0], name = pair.split('=')[0];
        if (!cookies.has(url.hostname)) cookies.set(url.hostname, new Map());
        cookies.get(url.hostname).set(name, pair);
        if (cookieStore) await cookieStore.setFromHeader(url.hostname, cookie);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location'), url);
        if (/signup|captcha|verify/.test(url.pathname)) throw new CiweimaoError('官网要求登录或人工验证，同步已暂停', 'ACCESS');
        if (++redirects > 3) throw new CiweimaoError('官网跳转次数异常');
        if (response.status === 303 || [301, 302].includes(response.status) && method === 'POST') { method = 'GET'; data = undefined; }
        attempt--; continue;
      }
      if ([401, 403, 429].includes(response.status)) { await response.body?.cancel(); throw new CiweimaoError('官网要求登录、人工验证或限流，同步已暂停', 'ACCESS'); }
      if (response.status >= 500 && attempt < 2) { await response.body?.cancel(); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new CiweimaoError(`官网返回 HTTP ${response.status}`, response.status === 404 ? 'MISSING' : 'NETWORK'); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new CiweimaoError('官网响应超过大小限制');
          chunks.push(chunk);
        }
      } catch (error) { if (signal?.aborted || error instanceof CiweimaoError) throw error; throw new CiweimaoError('官网响应未接收完整，请稍后重试', 'NETWORK'); }
      return Buffer.concat(chunks).toString('utf8');
    }
  }
  async function post(path, id, extra = {}) {
    const text = await request(WAP + path, { method: 'POST', data: { chapter_id: id, ...extra }, referer: `${WAP}/chapter/${id}` });
    let result;
    try { result = JSON.parse(text); } catch { throw new CiweimaoError('正文接口需要人工验证，同步已暂停', 'ACCESS'); }
    if (String(result?.code) !== '100000') {
      const tip = String(result?.tip || result?.msg || '正文接口拒绝请求').slice(0, 200);
      throw new CiweimaoError(tip, /购买|订阅|付费|收费|VIP/i.test(tip) ? 'PAID' : 'ACCESS');
    }
    return result;
  }
  return {
    async discover(page = 1) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new CiweimaoError('书库页码无效', 'INPUT', 400);
      if (page > 1 && !checkedListGate) {
        verificationPage = parseCiweimaoBookList(await request(`${WEB}/book_list/0-0-0-0-0-0/quanbu/1`), 1).verificationPage;
        checkedListGate = true;
      }
      if (verificationPage && page >= verificationPage && !cookies.get('www.ciweimao.com')?.has('booklistCode')) throw new CiweimaoError('书库继续翻页需要官网人工验证，扫描断点已保存', 'ACCESS');
      const result = parseCiweimaoBookList(await request(`${WEB}/book_list/0-0-0-0-0-0/quanbu/${page}`), page);
      verificationPage = result.verificationPage;
      checkedListGate = true;
      return result;
    },
    async search(keyword) {
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) throw new CiweimaoError('请输入 1–100 字的搜索词', 'INPUT', 400);
      return parseCiweimaoSearch(await request(`${WEB}/get-search-book-list/0-0-0-0-0-0/${encodeURIComponent('全部')}/${encodeURIComponent(keyword.trim())}/1`));
    },
    async catalog(id) { return parseCiweimaoCatalog(await request(`${WAP}/book/${ciweimaoId(id)}`), id); },
    async content(bookId, chapter) {
      if (!chapter.free) throw new CiweimaoError('收费章节已跳过', 'PAID');
      const html = await request(`${WAP}/chapter/${chapter.id}`);
      const identity = /HB\.book\s*=\s*\{\s*book_id:\s*(\d+),\s*chapter_id:\s*(\d+)/.exec(html);
      if (!identity || identity[1] !== bookId || identity[2] !== chapter.id) throw new CiweimaoError('阅读页与请求作品不符');
      const mode = /cwmwapbookread\.useImage\s*=\s*(\d+)/.exec(html);
      if (mode && mode[1] !== '0') throw new CiweimaoError('收费图片章节已跳过', 'PAID');
      const $ = load(html);
      if ($('#J_BookRead p.chapter').length) return cleanCiweimaoContent($('#J_BookRead').html());
      if (!mode) throw new CiweimaoError('无法确认章节为免费阅读模式');
      const access = (await post('/chapter/ajax_get_session_code', chapter.id)).chapter_access_key;
      if (typeof access !== 'string' || !access) throw new CiweimaoError('未取得免费正文会话');
      const result = await post('/chapter/get_book_chapter_detail_info', chapter.id, { chapter_access_key: access });
      return cleanCiweimaoContent(decodeCiweimaoContent(result.chapter_content, result.encryt_keys, access));
    },
    async close() { await network.dispatcher.close(); }
  };
}
