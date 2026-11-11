import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ArchiveError } from './library.mjs';

const derive = promisify(scrypt);
const cookieName = 'archive_admin';
const sessionLifetime = 12 * 60 * 60 * 1000;

export async function createAdminCredentials(username, password) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(username)) throw new Error('账号需要 1–64 个文字、数字、下划线、点或短横线');
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('密码需要 8–1024 个字符');
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await derive(password, salt, 64)).toString('hex');
  return { version: 1, username, salt, passwordHash };
}

export async function createAdminAuth(path) {
  if (!path) return null;
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  if (credentials.version !== 1 || typeof credentials.username !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(credentials.username) || !/^[a-f0-9]{32}$/.test(credentials.salt) || !/^[a-f0-9]{128}$/.test(credentials.passwordHash)) throw new Error('管理登录配置无效，请使用 admin:create 重新创建');
  const sessions = new Map(), failures = new Map();
  const digest = token => createHash('sha256').update(token).digest('hex');
  function token(req) {
    const value = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  }
  function session(req) {
    const value = token(req);
    if (!value) return null;
    const key = digest(value), expiresAt = sessions.get(key);
    if (!expiresAt || expiresAt <= Date.now()) { sessions.delete(key); return null; }
    return { username: credentials.username };
  }
  function cookie(value, secure, maxAge) {
    return cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
  }
  async function login(req, res, payload, secure) {
    const client = req.socket.remoteAddress || 'unknown';
    const now = Date.now(), failure = failures.get(client);
    if (failure?.until > now && failure.count >= 8) {
      const error = new ArchiveError('登录失败次数过多，请稍后重试', 429);
      error.retryAfter = Math.max(1, Math.ceil((failure.until - now) / 1000));
      throw error;
    }
    if (!payload || typeof payload.username !== 'string' || typeof payload.password !== 'string' || payload.username.length > 64 || payload.password.length > 1024) throw new ArchiveError('请填写账号和密码', 400);
    // Reserve an attempt before the asynchronous hash so concurrent requests
    // cannot all observe the same pre-login failure count.
    if (failures.size >= 256 && !failures.has(client)) failures.delete(failures.keys().next().value);
    failures.set(client, { count: failure?.until > now ? failure.count + 1 : 1, until: failure?.until > now ? failure.until : now + 15 * 60 * 1000 });
    const hash = await derive(payload.password, credentials.salt, 64);
    const matched = timingSafeEqual(hash, Buffer.from(credentials.passwordHash, 'hex'));
    if (!matched || payload.username !== credentials.username) {
      throw new ArchiveError('账号或密码不正确', 401);
    }
    failures.delete(client);
    for (const [key, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(key);
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
    const value = randomBytes(32).toString('hex');
    sessions.set(digest(value), now + sessionLifetime);
    res.setHeader('Set-Cookie', cookie(value, secure, sessionLifetime / 1000));
    return { username: credentials.username };
  }
  function logout(req, res, secure) {
    const value = token(req);
    if (value) sessions.delete(digest(value));
    res.setHeader('Set-Cookie', cookie('', secure, 0));
  }
  return { session, login, logout };
}
