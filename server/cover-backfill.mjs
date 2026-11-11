import { readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadCoverImage, coverFailure } from './cover.mjs';
import { writeJsonAtomic } from './download-queue.mjs';

/** Update a generated book directory without reading or replacing its full text. */
export async function backfillBookCover(directory, options = {}) {
  const root = resolve(directory), manifestPath = join(root, 'book.json');
  if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('书籍元数据超过大小限制');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original.replace(/^\uFEFF/, ''));
  if (manifest.files?.cover) {
    const coverPath = resolve(root, manifest.files.cover), rel = relative(root, coverPath);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('封面文件超出书籍目录');
    try { if ((await stat(coverPath)).size > 0) return { id: manifest.id, status: 'existing' }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!manifest.source?.coverUrl) return { id: manifest.id, status: 'unavailable' };
  let image;
  try { image = await downloadCoverImage(manifest.source.coverUrl, { ...options, referer: manifest.source.url }); }
  catch (error) { if (options.signal?.aborted) throw error; return { id: manifest.id, ...coverFailure(error) }; }
  options.signal?.throwIfAborted();
  const temporary = join(root, '.cover-' + randomUUID());
  try {
    await writeFile(temporary, image.buffer, { flag: 'wx' });
    await rename(temporary, join(root, image.name));
  } finally { await rm(temporary, { force: true }); }
  if (await readFile(manifestPath, 'utf8') !== original) throw new Error('补封面时书籍资料被修改，请重试以保留最新资料');
  manifest.files = { ...manifest.files, cover: image.name };
  manifest.coverDownload = { status: 'downloaded', bytes: image.bytes, checkedAt: new Date().toISOString() };
  await writeJsonAtomic(manifestPath, manifest);
  return { id: manifest.id, status: 'downloaded', bytes: image.bytes };
}
