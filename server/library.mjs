import { readFile, writeFile, readdir, mkdir, stat, realpath, rename, rm } from 'node:fs/promises';
import { resolve, relative, dirname, basename, extname, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { decodeBook, indexBook } from './text.mjs';

export class ArchiveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const validId = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
const textExtensions = new Set(['.txt', '.md', '.text']);
const coverExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
function inside(root, target) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'));
}
function checkedPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..') || name.includes('\0')) throw new ArchiveError('文件路径必须位于当前书籍目录内');
  const target = resolve(root, name);
  if (!inside(root, target) || target === root) throw new ArchiveError('不安全的文件路径');
  return target;
}
async function existingPath(root, name, resolvedRoot) {
  const target = checkedPath(root, name);
  const actual = await realpath(target);
  const actualRoot = resolvedRoot || await realpath(root);
  if (!inside(actualRoot, actual)) throw new ArchiveError('文件路径不能通过链接指向书籍目录以外');
  const info = await stat(actual);
  if (!info.isFile()) throw new ArchiveError('书稿路径不是文件');
  return { path: actual, info };
}
function fileNames(raw) {
  const supplied = raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? { ...raw.files } : {};
  supplied.text ??= raw.textFile ?? raw.contentFile ?? raw.file;
  supplied.cover ??= raw.coverFile ?? (typeof raw.cover === 'string' && !/^https?:/i.test(raw.cover) ? raw.cover : undefined);
  return Object.fromEntries(Object.entries(supplied).filter(([, value]) => typeof value === 'string' && value));
}
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArchiveError('书籍 JSON 必须是对象');
  if (!validId.test(raw.id || '')) throw new ArchiveError('id 必须是 1–80 个字母、汉字、数字、下划线或连字符');
  if (typeof raw.title !== 'string' || !raw.title.trim()) throw new ArchiveError('缺少书名 title');
  for (const key of ['description', 'introduction', 'summary', 'originalTitle', 'category', 'status', 'translator', 'illustrator', 'publisher', 'language', 'encoding', 'updatedAt', 'addedAt']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new ArchiveError(key + ' 字段必须是文本');
  }
  if (raw.source?.name !== undefined && typeof raw.source.name !== 'string') throw new ArchiveError('source.name 字段必须是文本');
  const files = fileNames(raw);
  if (!files.text) throw new ArchiveError('缺少 files.text 指向整本 TXT/MD 文件');
  if (!textExtensions.has(extname(files.text).toLowerCase())) throw new ArchiveError('阅读正文必须是 TXT 或 MD 文件');
  return files;
}
function authorName(raw) {
  const value = raw.author ?? raw.authors;
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : typeof item?.name === 'string' ? item.name : '').filter(Boolean).join(' / ') || '佚名' : typeof value === 'string' ? value : typeof value?.name === 'string' ? value.name : '佚名';
}
function strings(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  if (typeof value === 'string') return value.split(/[,，、]/).map(item => item.trim()).filter(Boolean);
  return [];
}
function safeSource(source) {
  if (typeof source === 'string') return { name: source };
  if (!source || typeof source !== 'object') return {};
  const result = { ...source };
  if (result.url && !/^https?:\/\//i.test(result.url)) delete result.url;
  return result;
}
async function manifestsAt(root, depth = 0) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = await mapLimit(entries.sort((a, b) => a.name.localeCompare(b.name)), 12, async entry => {
    if (entry.name.startsWith('.')) return [];
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth < 3) return manifestsAt(path, depth + 1);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.json') ? [path] : [];
  });
  return results.flat();
}
async function mapLimit(items, concurrency, visit) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await visit(items[index], index); }
  }));
  return results;
}
export function createLibrary(rootPath) {
  const root = resolve(rootPath);
  const documentCache = new Map();
  const manifestCache = new Map();
  let entriesById = new Map();
  let scanInFlight, catalogSnapshot, scannedAtMs = 0;
  async function readEntry(path) {
        const manifestInfo = await stat(path);
        if (manifestInfo.size > 1024 * 1024) throw new ArchiveError('元数据 JSON 超过 1 MB');
        const signature = [manifestInfo.mtimeMs, manifestInfo.ctimeMs, manifestInfo.size, manifestInfo.ino].join(':');
        const saved = manifestCache.get(path);
        const raw = saved?.signature === signature ? saved.raw : JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
        manifestCache.set(path, { signature, raw });
        if (raw.published === false) return null;
        const files = validateManifest(raw);
        const folder = dirname(path);
        const actualFolder = await realpath(folder);
        const resolvedFiles = {};
        await Promise.all(Object.entries(files).map(async ([kind, name]) => {
          try {
            if (kind === 'cover' && !coverExtensions.has(extname(name).toLowerCase())) return;
            const file = await existingPath(folder, name, actualFolder);
            resolvedFiles[kind] = { ...file, name };
          } catch (error) { if (kind === 'text') throw error; }
        }));
        const text = resolvedFiles.text;
        if (text.info.size === 0) throw new ArchiveError('书稿为空，尚未发布');
        const status = raw.status || (raw.completed ? '已完结' : '未标注');
        const book = {
          id: raw.id, title: raw.title.trim(), originalTitle: raw.originalTitle || '',
          author: authorName(raw), translator: raw.translator || '', illustrator: raw.illustrator || '',
          description: raw.description ?? raw.introduction ?? raw.summary ?? '',
          category: raw.category || '未分类', tags: strings(raw.tags), status,
          completed: /完结|完結|已完成|completed|complete/i.test(status),
          language: raw.language || 'zh', publisher: raw.publisher || '',
          updatedAt: raw.updatedAt ?? raw.lastUpdate ?? new Date(text.info.mtimeMs).toISOString(),
          addedAt: raw.addedAt ?? raw.importedAt ?? new Date(manifestInfo.birthtimeMs).toISOString(),
          publishedYear: raw.publishedYear || '', source: safeSource(raw.source),
          wordCount: Number(raw.wordCount) || null, chapterCount: Number(raw.chapterCount) || null,
          volumeCount: Number(raw.volumeCount) || null, bytes: text.info.size,
          encoding: raw.encoding || 'auto',
          coverUrl: resolvedFiles.cover ? '/api/books/' + encodeURIComponent(raw.id) + '/files/cover' : null,
          downloadUrl: '/api/books/' + encodeURIComponent(raw.id) + '/files/text',
          formats: Object.keys(files).filter(key => key !== 'cover' && resolvedFiles[key]).map(key => extname(resolvedFiles[key].name).slice(1).toUpperCase()),
        };
        const cached = documentCache.get(raw.id);
        if (cached && cached.signature === text.info.mtimeMs + ':' + text.info.size) {
          book.wordCount ??= cached.document.wordCount;
          book.chapterCount ??= cached.document.chapters.length;
        }
        return { book, raw, files: resolvedFiles, manifestPath: path };
  }
  async function rebuildCatalog() {
    const books = [], invalidEntries = [], nextEntries = new Map();
    const paths = await manifestsAt(root);
    const results = await mapLimit(paths, 12, async path => {
      try { return { entry: await readEntry(path), path }; }
      catch (error) { return { error, path }; }
    });
    for (const { entry, path, error } of results) {
      const problem = error || (entry && nextEntries.has(entry.book.id) ? new ArchiveError('存在重复的书籍 id：' + entry.book.id) : null);
      if (problem) invalidEntries.push({ file: relative(root, path).replaceAll('\\', '/'), message: problem.code === 'ENOENT' ? '书稿文件不存在，等待文件完整后会自动上架' : problem.message });
      else if (entry) { nextEntries.set(entry.book.id, entry); books.push(entry.book); }
    }
    const present = new Set(paths);
    for (const path of manifestCache.keys()) if (!present.has(path)) manifestCache.delete(path);
    entriesById = nextEntries;
    catalogSnapshot = {
      books, invalidEntries, libraryPath: root, scannedAt: new Date().toISOString(),
      revision: createHash('sha256').update(JSON.stringify({ books, invalidEntries })).digest('hex'),
      stats: { total: books.length, completed: books.filter(book => book.completed).length, bytes: books.reduce((sum, book) => sum + book.bytes, 0), authors: new Set(books.map(book => book.author)).size }
    };
    scannedAtMs = Date.now();
    return catalogSnapshot;
  }
  async function scan({ maxAgeMs = 0 } = {}) {
    if (scanInFlight) return scanInFlight;
    if (catalogSnapshot && maxAgeMs > 0 && Date.now() - scannedAtMs < maxAgeMs) return catalogSnapshot;
    scanInFlight = rebuildCatalog();
    try { return await scanInFlight; }
    finally { scanInFlight = null; }
  }
  async function entry(id) {
    if (!entriesById.has(id)) await scan();
    const saved = entriesById.get(id);
    const found = saved ? await readEntry(saved.manifestPath) : null;
    if (!found || found.book.id !== id) throw new ArchiveError('找不到这本书，可能尚未完整发布', 404);
    return found;
  }
  async function documentFor(found) {
    const file = found.files.text;
    if (file.info.size > 128 * 1024 * 1024) throw new ArchiveError('在线阅读暂支持 128 MB 以内的文本，仍可下载原文件', 413);
    const signature = file.info.mtimeMs + ':' + file.info.size;
    const cached = documentCache.get(found.book.id);
    if (cached?.signature === signature) return cached.document;
    const decoded = decodeBook(await readFile(file.path), found.raw.encoding || 'auto');
    const document = { ...indexBook(decoded.text), encoding: decoded.encoding };
    documentCache.set(found.book.id, { signature, document });
    if (documentCache.size > 4) documentCache.delete(documentCache.keys().next().value);
    return document;
  }
  return {
    root, scan, invalidate() { scannedAtMs = 0; },
    async detail(id) {
      const found = await entry(id);
      const document = await documentFor(found);
      return {
        ...found.book, wordCount: document.wordCount, chapterCount: document.chapters.length, encoding: document.encoding,
        chapters: document.chapters.map(({ start, end, ...chapter }) => chapter),
        metadata: found.raw,
        files: Object.entries(found.files).map(([kind, file]) => ({ kind, name: file.name, bytes: file.info.size, url: '/api/books/' + encodeURIComponent(id) + '/files/' + encodeURIComponent(kind) }))
      };
    },
    async chapter(id, index) {
      const found = await entry(id);
      const document = await documentFor(found);
      const chapter = document.chapters[index];
      if (!chapter || !Number.isInteger(index)) throw new ArchiveError('章节不存在', 404);
      return { ...chapter, content: document.text.slice(chapter.start, chapter.end).trim(), total: document.chapters.length };
    },
    async file(id, kind) {
      const found = await entry(id);
      const file = found.files[kind];
      if (!file) throw new ArchiveError('文件不存在', 404);
      return file;
    }
  };
}
export async function publishBundle(rootPath, supplied, buffers) {
  const raw = structuredClone(supplied);
  const files = validateManifest(raw);
  const root = resolve(rootPath);
  await mkdir(root, { recursive: true });
  const destination = join(root, raw.id);
  try { await stat(destination); throw new ArchiveError('书籍 id 已存在，请更换 id 或直接更新该书目录', 409); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of Object.values(files)) checkedPath(destination, name);
  for (const [name, buffer] of Object.entries(buffers)) {
    checkedPath(destination, name);
    if (!Buffer.isBuffer(buffer)) throw new ArchiveError('文件内容必须为二进制数据');
    if (buffer.length > 128 * 1024 * 1024) throw new ArchiveError('单个文件不能超过 128 MB', 413);
  }
  if (!buffers[files.text]?.length) throw new ArchiveError('未提供完整的正文文件');
  const document = indexBook(decodeBook(buffers[files.text], raw.encoding || 'auto').text);
  raw.files = files;
  raw.wordCount = document.wordCount;
  raw.chapterCount = document.chapters.length;
  raw.addedAt ??= new Date().toISOString();
  raw.integrity = { ...raw.integrity, sha256: createHash('sha256').update(buffers[files.text]).digest('hex') };
  const staging = join(root, '.import-' + randomUUID());
  await mkdir(staging);
  try {
    for (const [name, buffer] of Object.entries(buffers)) {
      const path = checkedPath(staging, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer, { flag: 'wx' });
    }
    await writeFile(join(staging, 'book.json'), JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' });
    await rename(staging, destination);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { id: raw.id, directory: destination, bytes: buffers[files.text].length, sha256: raw.integrity.sha256, chapters: raw.chapterCount };
}
