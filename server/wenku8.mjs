import { load } from 'cheerio';
import { ArchiveError } from './library.mjs';
import { cookieHeaderFor } from './downloader.mjs';
import { decodeBook } from './text.mjs';
import { languageRank } from '../shared/language.mjs';

const sourceHosts = new Set(['www.wenku8.net', 'wenku8.net']);
const downloadHosts = new Set(['dl.wenku8.com', 'dl.wenku8.net']);
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function normalizeWenkuBook(input) {
  let id = String(input || '').trim();
  if (!/^[1-9]\d{0,7}$/.test(id)) {
    let url;
    try { url = new URL(id); } catch { throw new ArchiveError('请输入书籍编号或文库书籍网址'); }
    if (!sourceHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new ArchiveError('只接受本站的书籍网址');
    id = /^\/book\/([1-9]\d{0,7})\.htm$/.exec(url.pathname)?.[1] || (url.pathname === '/modules/article/articleinfo.php' ? url.searchParams.get('id') : '');
    if (!/^[1-9]\d{0,7}$/.test(id || '')) throw new ArchiveError('网址必须指向书籍资料页');
  }
  return { id, infoUrl: 'https://www.wenku8.net/modules/article/articleinfo.php?id=' + id, bookUrl: 'https://www.wenku8.net/book/' + id + '.htm' };
}

function pageDocument(html) {
  if (typeof html !== 'string' || !html.trim()) throw new ArchiveError('网页内容为空');
  const $ = load(html);
  $('script,style,iframe').remove();
  const archivedUrl = webUrl($('meta[name="archive-source-url"]').attr('content'), 'https://www.wenku8.net/');
  if (archivedUrl?.pathname === '/login.php') throw new ArchiveError('保存的页面已跳转到登录页，请恢复登录后重新保存全本页', 401);
  if (/请稍候|Just a moment|安全验证|安全驗證/i.test($('title').text()) || /正在进行安全验证|正在進行安全驗證/.test($('h1,h2').text())) throw new ArchiveError('站点要求安全验证，请在正常浏览器中完成验证后重试', 403);
  return $;
}
function loginPage($) {
  return $('input[type="password"]').length > 0 || $('caption').toArray().some(element => /^(用户登录|用戶登錄)$/.test(clean($(element).text())));
}
export const wenkuCatalogUrl = 'https://www.wenku8.net/modules/article/toplist.php?sort=postdate';

export function parseWenkuCatalog(html) {
  const $ = pageDocument(html);
  if (loginPage($)) throw new ArchiveError('新书列表需要登录，请更新本地 Cookie', 401);
  const ids = new Set();
  $('a[href]').each((_index, element) => {
    const url = webUrl($(element).attr('href'), wenkuCatalogUrl);
    if (!url || !sourceHosts.has(url.hostname)) return;
    const value = /^\/book\/([1-9]\d{0,7})\.htm$/.exec(url.pathname)?.[1]
      || (url.pathname === '/modules/article/articleinfo.php' ? url.searchParams.get('id') : '');
    if (/^[1-9]\d{0,7}$/.test(value || '')) ids.add(Number(value));
  });
  if (!ids.size) throw new ArchiveError('新书列表未识别到书籍编号，保留当前范围并稍后重试', 415);
  return { highestId: Math.max(...ids), listedCount: ids.size };
}
function webUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}
function blockText($, element) {
  const copy = $(element).clone();
  copy.find('br').replaceWith('\n');
  return copy.text().replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

export function parseWenkuInfo(html, input) {
  const source = normalizeWenkuBook(input);
  const $ = pageDocument(html);
  const content = $('#content');
  const fields = content.find('td').toArray().map(element => clean($(element).text()));
  const field = (...labels) => {
    for (const label of labels) {
      const found = fields.find(text => text.startsWith(label + '：') || text.startsWith(label + ':'));
      if (found) return found.slice(label.length + 1).trim();
    }
    return '';
  };
  const title = clean(content.find('table').first().find('b').first().text()) || clean(content.find('h1').first().text());
  const author = field('小说作者', '小說作者');
  if (!title || !author) {
    if (loginPage($)) throw new ArchiveError('书籍资料页需要登录，请更新本地 Cookie', 401);
    if (/(?:小说|小說|文章|作品|书籍|書籍).{0,12}(?:不存在|已(?:经|經)?(?:删除|刪除))/.test(clean(content.length ? content.text() : $('body').text()))) throw new ArchiveError('该编号的书籍不存在或已删除', 404);
    throw new ArchiveError('未识别到书名和作者，资料页结构可能已变化');
  }
  const labels = content.find('.hottext').toArray();
  const label = pattern => labels.find(element => pattern.test(clean($(element).text())));
  const intro = label(/^(内容简介|內容簡介)[：:]/);
  const tags = label(/^作品Tags[：:]/i);
  const latest = label(/^(最近章节|最近章節)[：:]/);
  const latestLink = latest ? $(latest).nextAll('span').first().find('a').first() : null;
  const latestUrl = latestLink?.length ? webUrl(latestLink.attr('href'), source.infoUrl) : null;
  const sourceDate = field('最后更新', '最後更新');
  const updatedAt = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(sourceDate)?.[0];
  const image = content.find('img[src]').toArray().map(element => webUrl($(element).attr('src'), source.infoUrl)).find(url => url && url.pathname.includes('/' + source.id + '/') && /\.(?:jpe?g|png|webp)$/i.test(url.pathname));
  if (image && image.hostname === 'img.wenku8.com') image.protocol = 'https:';
  const downloadPage = content.find('a[href]').toArray().map(element => webUrl($(element).attr('href'), source.infoUrl)).find(url => url && sourceHosts.has(url.hostname) && url.pathname === '/modules/article/packshow.php' && url.searchParams.get('id') === source.id && url.searchParams.get('type') === 'txtfull');
  return {
    id: 'wenku8-' + source.id, title, author,
    description: intro ? blockText($, $(intro).nextAll('span').first()) : '',
    category: field('文库分类', '文庫分類') || '未分类',
    tags: tags ? clean($(tags).text()).replace(/^作品Tags[：:]\s*/i, '').split(/[\s,，、]+/).filter(Boolean) : [],
    status: field('文章状态', '文章狀態') || '未标注',
    ...(updatedAt ? { updatedAt } : {}),
    language: 'und', encoding: 'auto', files: { text: 'content.txt' },
    source: {
      name: '轻小说文库', id: source.id, url: source.bookUrl,
      ...(updatedAt ? { updatedAt } : {}),
      wordCount: Number(field('全文长度', '全文長度').replace(/[^\d]/g, '')) || null,
      ...(image ? { coverUrl: image.href } : {}),
      ...(downloadPage ? { downloadPageUrl: downloadPage.href } : {}),
      ...(latestUrl ? { latestChapter: { title: clean(latestLink.text()), url: latestUrl.href } } : {}),
      inspectedAt: new Date().toISOString()
    }
  };
}

export function parseWenkuDownloads(html, input) {
  const source = normalizeWenkuBook(input);
  const $ = pageDocument(html);
  const variants = [];
  const seen = new Set();
  for (const element of $('a[href]').toArray()) {
    const url = webUrl($(element).attr('href'), source.infoUrl);
    if (!url || !downloadHosts.has(url.hostname) || url.pathname !== '/down.php' || url.searchParams.get('id') !== source.id || ['fname', 'vid', 'cid', 'chapter', 'volume'].some(key => url.searchParams.has(key))) continue;
    const type = url.searchParams.get('type');
    if (!['utf8', 'txt', 'big5'].includes(type) || seen.has(url.href)) continue;
    if (!/TXT(?:全文|全本)下载|TXT(?:全文|全本)下載/.test(clean($('caption').text()))) throw new ArchiveError('这不是 TXT 全本下载页面，不处理分卷下载');
    seen.add(url.href);
    variants.push({ language: type === 'big5' ? 'zh-Hant' : 'zh-Hans', encoding: type === 'txt' ? 'gb18030' : 'utf-8', url: url.href, node: url.searchParams.get('node') || '', label: clean($(element).text()) });
  }
  if (!variants.length) {
    if (loginPage($)) throw new ArchiveError('全本下载页需要登录，请更新本地 Cookie，或使用已登录浏览器保存的 HTML', 401);
    throw new ArchiveError('页面未展示可用的完整 TXT 下载入口，不会自行拼接下载地址', 404);
  }
  return variants.sort((a, b) => languageRank(a.language) - languageRank(b.language) || Number(a.encoding !== 'utf-8') - Number(b.encoding !== 'utf-8'));
}

export async function fetchWenkuPage(inputUrl, options = {}) {
  let url = new URL(inputUrl);
  const origin = url.origin;
  for (let step = 0; step <= 5; step++) {
    if (!sourceHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) throw new ArchiveError('资料请求重定向到了站点以外', 400);
    const headers = { 'User-Agent': 'LocalBookArchive/0.1', Accept: 'text/html' };
    const cookie = options.rawCookie ? url.origin === origin ? options.rawCookie : '' : cookieHeaderFor(url, options.cookies);
    if (cookie) { if (/[\r\n]/.test(cookie)) throw new ArchiveError('Cookie 不能包含换行'); headers.Cookie = cookie; }
    await options.beforeRequest?.();
    options.signal?.throwIfAborted();
    const response = await fetch(url, { headers, dispatcher: options.dispatcher, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(45000), ...(options.signal ? [options.signal] : [])]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || step === 5) throw new ArchiveError('资料页重定向过多');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      const error = new ArchiveError('站点资料请求返回 HTTP ' + response.status + (response.status === 403 ? '，可能需要浏览器验证' : ''), response.status);
      error.retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()) : 0;
      throw error;
    }
    if (url.pathname === '/login.php') { await response.body?.cancel(); throw new ArchiveError('全本入口需要有效登录态，请更新本地 Cookie', 401); }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 3 * 1024 * 1024) throw new ArchiveError('资料页超过 3 MB 限制', 413);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1] || /charset\s*=\s*["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString('ascii'))?.[1];
    return decodeBook(buffer, charset || 'auto').text;
  }
  throw new ArchiveError('无法读取站点资料');
}
