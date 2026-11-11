import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ArchiveError } from './library.mjs';
import { writeJsonAtomic } from './download-queue.mjs';

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

export async function createAdminAuth(path, captcha) {
  if (!path) return null;
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  if (credentials.version !== 1 || typeof credentials.username !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(credentials.username) || !/^[a-f0-9]{32}$/.test(credentials.salt) || !/^[a-f0-9]{128}$/.test(credentials.passwordHash)) throw new Error('管理登录配置无效，请使用 admin:create 重新创建');
  const usersPath = join(dirname(path), 'users.json');
  let users = [];
  try {
    const saved = JSON.parse(await readFile(usersPath, 'utf8'));
    if (!Array.isArray(saved) || saved.some(user => typeof user.username !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(user.username) || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{128}$/.test(user.passwordHash))) throw new Error('注册用户配置无效');
    users = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = new Map();
  const digest = token => createHash('sha256').update(token).digest('hex');
  function token(req) {
    const value = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  }
  function session(req) {
    const value = token(req);
    if (!value) return null;
    const key = digest(value), current = sessions.get(key);
    if (!current || current.expiresAt <= Date.now()) { sessions.delete(key); return null; }
    return { username: current.username, role: current.role };
  }
  function cookie(value, secure, maxAge) {
    return cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
  }
  function establishSession(res, username, role, secure) {
    const now = Date.now();
    for (const [key, current] of sessions) if (current.expiresAt <= now) sessions.delete(key);
    if (sessions.size >= 4096) sessions.delete(sessions.keys().next().value);
    const value = randomBytes(32).toString('hex');
    sessions.set(digest(value), { username, role, expiresAt: now + sessionLifetime });
    res.setHeader('Set-Cookie', cookie(value, secure, sessionLifetime / 1000));
    return { username, role };
  }
  async function authenticate(req, res, payload, secure, purpose) {
    if (!payload || typeof payload.username !== 'string' || typeof payload.password !== 'string' || payload.username.length > 64 || payload.password.length > 1024) throw new ArchiveError('请填写账号和密码', 400);
    captcha.verify(req, payload, purpose);
    const isAdmin = payload.username === credentials.username;
    const user = isAdmin ? credentials : users.find(item => item.username === payload.username);
    const source = user || credentials;
    const hash = await derive(payload.password, source.salt, 64);
    const matched = timingSafeEqual(hash, Buffer.from(source.passwordHash, 'hex'));
    if (!user || !matched) throw new ArchiveError('账号或密码不正确', 401);
    const role = isAdmin ? 'admin' : 'reader';
    return establishSession(res, user.username, role, secure);
  }
  async function login(req, res, payload, secure) {
    return authenticate(req, res, payload, secure, 'login');
  }
  async function register(req, res, payload, secure) {
    if (!payload || typeof payload.username !== 'string' || typeof payload.password !== 'string' || payload.username.length > 64 || payload.password.length < 8 || payload.password.length > 1024) throw new ArchiveError('账号需为 1–64 个字符，密码需为 8–1024 个字符', 400);
    if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(payload.username)) throw new ArchiveError('账号只能包含文字、数字、下划线、点或短横线', 400);
    captcha.verify(req, payload, 'register');
    if (payload.username.toLowerCase() === credentials.username.toLowerCase() || users.some(user => user.username.toLowerCase() === payload.username.toLowerCase())) throw new ArchiveError('这个账号已被使用', 409);
    const created = await createAdminCredentials(payload.username, payload.password);
    const next = [...users, created];
    await writeJsonAtomic(usersPath, next);
    users = next;
    return establishSession(res, created.username, 'reader', secure);
  }
  function logout(req, res, secure) {
    const value = token(req);
    if (value) sessions.delete(digest(value));
    res.setHeader('Set-Cookie', cookie('', secure, 0));
  }
  let registration = Promise.resolve();
  return { session, login, register(req, res, payload, secure) {
    const result = registration.then(() => register(req, res, payload, secure));
    registration = result.catch(() => {});
    return result;
  }, logout };
}
