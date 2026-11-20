import { mkdir, readFile, rename, unlink, chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArchiveError } from './library.mjs';

export const CIWEIMAO_HOSTS = new Set(['ciweimao.com', 'www.ciweimao.com', 'wap.ciweimao.com']);
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_COOKIES = 200;
const MAX_COOKIE_VALUE = 4096;
const MAX_FILE_BYTES = 1024 * 1024;

function domain(value) {
  const result = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  if (!CIWEIMAO_HOSTS.has(result)) throw new ArchiveError('Cookie 域名必须是 ciweimao.com、www.ciweimao.com 或 wap.ciweimao.com', 400);
  return result;
}

function path(value) {
  const result = typeof value === 'string' && value.startsWith('/') ? value : '/';
  if (result.length > 256) throw new ArchiveError('Cookie 路径过长', 400);
  return result;
}

function expiry(value) {
  if (value == null || value === '' || value === -1) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number)) return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.floor(date / 1000) : null;
}

function entry(raw, fallbackDomain = 'www.ciweimao.com') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArchiveError('Cookie 条目格式不正确', 400);
  const name = String(raw.name || '').trim(), value = String(raw.value ?? '');
  if (!COOKIE_NAME.test(name)) throw new ArchiveError('Cookie 名称不合法', 400);
  if (value.length > MAX_COOKIE_VALUE || /[\r\n]/.test(value)) throw new ArchiveError('Cookie 值过长或包含换行', 400);
  return { name, value, domain: domain(raw.domain || fallbackDomain), path: path(raw.path), secure: raw.secure !== false, expires: expiry(raw.expires ?? raw.expirationDate) };
}

function fromHeader(header, fallbackDomain) {
  if (typeof header !== 'string' || header.length > MAX_FILE_BYTES) throw new ArchiveError('Cookie Header 不能为空且不能超过 1 MB', 400);
  return header.replace(/^Cookie:\s*/i, '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index <= 0) throw new ArchiveError('Cookie Header 格式不正确', 400);
    return entry({ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }, fallbackDomain);
  });
}

function fromPayload(payload) {
  const result = [];
  if (typeof payload.cookieHeader === 'string' && payload.cookieHeader.trim()) result.push(...fromHeader(payload.cookieHeader, payload.domain || 'ciweimao.com'));
  const rawCookies = Array.isArray(payload.cookies) ? payload.cookies : payload.storageState && Array.isArray(payload.storageState.cookies) ? payload.storageState.cookies : [];
  for (const raw of rawCookies) result.push(entry(raw, payload.domain));
  if (!result.length) throw new ArchiveError('请提供 Cookie Header 或浏览器导出的 Cookie JSON', 400);
  const unique = new Map(result.map(item => [`${item.domain}\0${item.path}\0${item.name}`, item]));
  if (unique.size > MAX_COOKIES) throw new ArchiveError(`Cookie 数量不能超过 ${MAX_COOKIES}`, 400);
  return [...unique.values()];
}

function safeEntries(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.cookies) || raw.cookies.length > MAX_COOKIES) throw new Error('invalid cookie store');
  return raw.cookies.map(item => entry(item, item.domain));
}

export class CiweimaoCookieStore {
  constructor(file) { this.file = file; this.entries = []; this.loaded = false; this.write = Promise.resolve(); }
  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const text = await readFile(this.file, { encoding: 'utf8' });
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('cookie store too large');
      this.entries = safeEntries(JSON.parse(text)).filter(item => !item.expires || item.expires > Date.now() / 1000);
    } catch (error) {
      if (error.code !== 'ENOENT') this.entries = [];
    }
    return this;
  }
  async refresh() {
    try {
      const text = await readFile(this.file, { encoding: 'utf8' });
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('cookie store too large');
      const raw = JSON.parse(text);
      this.entries = safeEntries(raw).filter(item => !item.expires || item.expires > Date.now() / 1000);
      this.updatedAt = raw.updatedAt || null;
    } catch (error) {
      if (error.code === 'ENOENT') { this.entries = []; this.updatedAt = null; }
    }
    this.loaded = true;
    return this;
  }
  status() {
    const domains = [...new Set(this.entries.map(item => item.domain))];
    return { configured: this.entries.length > 0, domains, count: this.entries.length, updatedAt: this.updatedAt || null };
  }
  header(hostname, requestPath = '/') {
    const host = String(hostname).toLowerCase();
    const now = Date.now() / 1000;
    const pathValue = typeof requestPath === 'string' && requestPath.startsWith('/') ? requestPath : '/';
    return this.entries.filter(item => {
      const cookiePath = item.path || '/';
      const pathMatches = pathValue === cookiePath || pathValue.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
      return (!item.expires || item.expires > now) && pathMatches && (item.domain === host || (item.domain === 'ciweimao.com' && CIWEIMAO_HOSTS.has(host)));
    }).map(item => `${item.name}=${item.value}`).join('; ');
  }
  async import(payload) {
    const items = fromPayload(payload);
    await this.load();
    this.entries = items;
    this.updatedAt = new Date().toISOString();
    await this.persist();
    return this.status();
  }
  async setFromHeader(hostname, header) {
    if (!header) return;
    const host = CIWEIMAO_HOSTS.has(hostname) ? hostname : 'www.ciweimao.com';
    const parts = String(header).split(';').map(part => part.trim()).filter(Boolean), pairs = parts.shift() || '';
    const index = pairs.indexOf('=');
    if (index <= 0) return;
    const attributes = new Map(parts.map(part => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator < 0 ? part.length : separator).trim().toLowerCase(), separator < 0 ? true : part.slice(separator + 1).trim()];
    }));
    const maxAge = attributes.has('max-age') ? Number(attributes.get('max-age')) : null;
    const item = entry({ name: pairs.slice(0, index).trim(), value: pairs.slice(index + 1).trim(), domain: attributes.get('domain') || host, path: attributes.get('path') || '/', secure: attributes.has('secure'), expires: maxAge !== null && Number.isFinite(maxAge) ? (maxAge <= 0 ? 0 : Date.now() / 1000 + maxAge) : attributes.get('expires') }, host);
    await this.load();
    const key = `${item.domain}\0${item.path}\0${item.name}`;
    this.entries = this.entries.filter(current => `${current.domain}\0${current.path}\0${current.name}` !== key);
    if (!(item.expires !== null && item.expires <= Date.now() / 1000)) this.entries.push(item);
    this.entries = this.entries.slice(-MAX_COOKIES);
    this.updatedAt = this.updatedAt || new Date().toISOString();
    await this.persist();
  }
  async clear() {
    this.entries = []; this.updatedAt = null; this.loaded = true;
    try { await unlink(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.status();
  }
  async persist() {
    const payload = JSON.stringify({ version: 1, updatedAt: this.updatedAt || new Date().toISOString(), cookies: this.entries });
    const temp = join(dirname(this.file), `.${this.file.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
    this.write = this.write.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
      try { await chmod(temp, 0o600); } catch {}
      await rename(temp, this.file);
      this.updatedAt = JSON.parse(payload).updatedAt;
    });
    return this.write;
  }
}

export async function createCiweimaoCookieStore(file) {
  const store = new CiweimaoCookieStore(file);
  await store.load();
  try { const raw = JSON.parse(await readFile(file, 'utf8')); store.updatedAt = raw.updatedAt || null; } catch {}
  return store;
}

