import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, realpath } from 'node:fs/promises';
import { resolve, join, relative, extname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLibrary, publishBundle, ArchiveError } from './library.mjs';
import { createWorkerController } from './worker-control.mjs';
import { createAdminAuth } from './admin-auth.mjs';
import { createCaptchaService } from './captcha.mjs';
import { languageRank } from '../shared/language.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req, maxBytes = 180 * 1024 * 1024) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new ArchiveError('请求必须使用 JSON', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new ArchiveError('请求总大小超出限制', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ArchiveError('JSON 格式不正确'); }
}
export async function createAppServer({ libraryRoot, webRoot, dev = false, worker, adminAuthFile, publicOrigin, captchaService = createCaptchaService() }) {
  let publicUrl;
  if (publicOrigin) {
    publicUrl = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('公开地址必须是完整的 HTTP/HTTPS origin，不包含路径或账号');
    if (!adminAuthFile) throw new Error('公开部署必须配置管理登录（ARCHIVE_AUTH_FILE）');
    if (dev) throw new Error('公开部署请先构建前端，不使用开发服务器');
  }
  const adminAuth = await createAdminAuth(adminAuthFile, captchaService);
  const library = createLibrary(libraryRoot);
  const workerControl = worker ? createWorkerController({ ...worker, libraryRoot }) : null;
  const publicRoot = resolve(webRoot);
  const vite = dev ? await (await import('vite')).createServer({
    server: { middlewareMode: true, fs: { deny: ['.env', '.env.*', '**/.git/**', '**/secrets/**', '**/library/**', '**/.state/**'] } },
    appType: 'spa'
  }) : null;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const host = req.headers.host || '127.0.0.1';
      const origin = publicUrl && host === publicUrl.host ? publicUrl.origin : 'http://' + host;
      const url = new URL(req.url || '/', origin);
      if (url.origin !== origin || (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && (!publicUrl || url.host !== publicUrl.host))) throw new ArchiveError('不允许访问此主机地址', 403);
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new ArchiveError('不支持的方法', 405);
      const currentSession = adminAuth?.session(req);
      const authState = (session = currentSession) => ({ enabled: !!adminAuth, registrationEnabled: !!adminAuth, authenticated: !adminAuth || !!session, username: session?.username || null, role: session?.role || null, canManage: !adminAuth || session?.role === 'admin', public: !!publicUrl });
      function requireSameOrigin() {
        if (req.headers.origin !== origin || req.headers['x-archive-client'] !== 'local-web') throw new ArchiveError('仅允许本站页面提交管理请求', 403);
      }
      if (url.pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, authState());
      if (url.pathname === '/api/auth/captcha' && req.method === 'GET') {
        if (!adminAuth) throw new ArchiveError('此实例未启用账号登录', 409);
        return json(res, 200, captchaService.issue(req, res, url.searchParams.get('purpose'), origin.startsWith('https:')));
      }
      const captchaMatch = /^\/api\/auth\/captcha\/([a-f0-9]{48})\.png$/.exec(url.pathname);
      if (captchaMatch && req.method === 'GET') {
        const image = captchaService.image(req, captchaMatch[1]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': image.length });
        return res.end(image);
      }
      if (['/api/auth/login', '/api/auth/register'].includes(url.pathname) && req.method === 'POST') {
        requireSameOrigin();
        if (!adminAuth) throw new ArchiveError('本地实例尚未启用管理登录', 409);
        const register = url.pathname.endsWith('/register');
        const session = await adminAuth[register ? 'register' : 'login'](req, res, await readJson(req, 8192), origin.startsWith('https:'));
        return json(res, register ? 201 : 200, authState(session));
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        requireSameOrigin();
        adminAuth?.logout(req, res, origin.startsWith('https:'));
        return json(res, 200, authState(null));
      }
      if (adminAuth && (url.pathname.startsWith('/api/worker/') || url.pathname === '/api/publish')) {
        if (!currentSession) throw new ArchiveError('请先登录管理账号', 401);
        if (currentSession.role !== 'admin') throw new ArchiveError('此功能仅限管理员使用', 403);
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, name: '文库档案' });
      if (url.pathname === '/api/library' && req.method === 'GET') {
        const catalog = await library.scan({ maxAgeMs: url.searchParams.get('refresh') === '1' ? 0 : 4000 });
        if (url.searchParams.get('preview') === '1') {
          const books = [...catalog.books].sort((a, b) => languageRank(a.language) - languageRank(b.language) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 24);
          return json(res, 200, { ...catalog, books, partial: books.length < catalog.books.length, libraryPath: publicUrl ? 'library/' : catalog.libraryPath });
        }
        const etag = '"' + catalog.revision + '"';
        res.setHeader('ETag', etag);
        if (String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) { res.writeHead(304, { 'Cache-Control': 'no-cache' }); return res.end(); }
        return json(res, 200, publicUrl ? { ...catalog, libraryPath: 'library/' } : catalog);
      }
      if (url.pathname === '/api/worker/status' && req.method === 'GET') return json(res, 200, workerControl ? await workerControl.status() : { available: false, running: false, status: 'unavailable' });
      if (['/api/worker/start', '/api/worker/stop'].includes(url.pathname) && req.method === 'POST') {
        requireSameOrigin();
        const payload = await readJson(req, 1024);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) throw new ArchiveError('此接口不接受命令、文件路径或自定义参数');
        if (!workerControl) throw new ArchiveError('此实例没有配置后台任务', 503);
        return json(res, 200, await workerControl[url.pathname.endsWith('/start') ? 'start' : 'stop']());
      }
      if (url.pathname === '/api/publish' && req.method === 'POST') {
        requireSameOrigin();
        const payload = await readJson(req);
        if (!Array.isArray(payload.files) || payload.files.length > 20) throw new ArchiveError('请提供 JSON 配套的正文和封面文件');
        const buffers = {};
        for (const file of payload.files) {
          if (typeof file.name !== 'string' || typeof file.base64 !== 'string' || file.name in buffers || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new ArchiveError('导入文件格式有误');
          buffers[file.name] = Buffer.from(file.base64, 'base64');
        }
        const receipt = await publishBundle(library.root, payload.manifest, buffers);
        library.invalidate();
        return json(res, 201, receipt);
      }
      const match = /^\/api\/books\/([^/]+)(?:\/(chapters|files)\/([^/]+))?$/.exec(url.pathname);
      if (match && ['GET', 'HEAD'].includes(req.method)) {
        const id = decodeURIComponent(match[1]);
        if (!match[2]) return json(res, 200, await library.detail(id));
        if (match[2] === 'chapters') return json(res, 200, await library.chapter(id, Number(match[3])));
        const kind = decodeURIComponent(match[3]);
        const file = await library.file(id, kind);
        res.setHeader('Content-Length', file.info.size);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', kind === 'cover' ? mime[extname(file.name).toLowerCase()] || 'application/octet-stream' : 'application/octet-stream');
        if (kind !== 'cover') res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(id + extname(file.name)));
        res.writeHead(200);
        if (req.method === 'HEAD') return res.end();
        return await pipeline(createReadStream(file.path), res);
      }
      if (url.pathname.startsWith('/api/')) throw new ArchiveError('接口不存在', 404);
      if (req.method === 'POST') throw new ArchiveError('页面不接受写入', 405);
      if (vite) return vite.middlewares(req, res, () => json(res, 404, { error: '页面不存在' }));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.split('/').some(part => part.startsWith('.') || ['secrets', 'server', 'library', 'node_modules'].includes(part))) throw new ArchiveError('文件不存在', 404);
      let target = resolve(publicRoot, '.' + pathname);
      const rel = relative(publicRoot, target);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new ArchiveError('文件不存在', 404);
      if (pathname === '/') target = join(publicRoot, 'index.html');
      const actual = await realpath(target);
      if (relative(publicRoot, actual).startsWith('..')) throw new ArchiveError('文件不存在', 404);
      const info = await stat(actual);
      if (!info.isFile()) throw new ArchiveError('文件不存在', 404);
      res.setHeader('Content-Type', mime[extname(actual)] || 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(actual), res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      json(res, status, { error: status === 500 ? '本地服务处理失败，请查看终端日志' : error.message });
      if (status === 500) console.error(error);
    }
  });
  server.on('close', () => { if (vite) void vite.close(); });
  return server;
}
