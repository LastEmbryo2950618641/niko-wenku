import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveError } from './library.mjs';

const validId = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
const maxRows = 500;
const fields = ['bookId', 'chapter', 'title', 'scroll', 'visitedAt'];

export function createReadingProgress(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'reading-progress.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS reading_progress (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      chapter INTEGER NOT NULL,
      title TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      scroll INTEGER NOT NULL,
      PRIMARY KEY (username, book_id)
    );
  `);
  const upsert = db.prepare(`
    INSERT INTO reading_progress (username, book_id, chapter, title, visited_at, scroll)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, book_id) DO UPDATE SET
      chapter = excluded.chapter,
      title = excluded.title,
      visited_at = excluded.visited_at,
      scroll = excluded.scroll
    WHERE excluded.visited_at >= reading_progress.visited_at
  `);
  const recent = db.prepare('SELECT book_id, chapter, title, visited_at, scroll FROM reading_progress WHERE username = ? ORDER BY visited_at DESC, book_id LIMIT ?');
  const one = db.prepare('SELECT chapter, title, visited_at, scroll FROM reading_progress WHERE username = ? AND book_id = ?');
  const trim = db.prepare(`
    DELETE FROM reading_progress
    WHERE username = ? AND book_id NOT IN (
      SELECT book_id FROM reading_progress WHERE username = ? ORDER BY visited_at DESC, book_id LIMIT ?
    )
  `);
  function list(username) {
    const progress = {};
    for (const row of recent.all(username, maxRows)) progress[row.book_id] = { chapter: row.chapter, title: row.title, visitedAt: row.visited_at, scroll: row.scroll };
    return progress;
  }
  function save(username, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ArchiveError('请求必须为 JSON 对象');
    if (Object.keys(payload).some(key => !fields.includes(key))) throw new ArchiveError('仅接受书籍、章节和阅读位置');
    if (typeof payload.bookId !== 'string' || !validId.test(payload.bookId)) throw new ArchiveError('书籍编号无效');
    if (!Number.isSafeInteger(payload.chapter) || payload.chapter < 0 || payload.chapter > 100000) throw new ArchiveError('章节位置无效');
    if (typeof payload.title !== 'string' || payload.title.length > 250) throw new ArchiveError('章节标题无效');
    const scroll = payload.scroll === undefined ? 0 : payload.scroll;
    if (!Number.isSafeInteger(scroll) || scroll < 0 || scroll > 5000000) throw new ArchiveError('阅读位置无效');
    const now = Date.now();
    const visitedAt = payload.visitedAt === undefined ? now : payload.visitedAt;
    if (!Number.isSafeInteger(visitedAt) || visitedAt < 0 || visitedAt > now + 60000) throw new ArchiveError('阅读时间无效');
    upsert.run(username, payload.bookId, payload.chapter, payload.title, visitedAt, scroll);
    trim.run(username, username, maxRows);
    const stored = one.get(username, payload.bookId);
    return { bookId: payload.bookId, chapter: stored.chapter, title: stored.title, visitedAt: stored.visited_at, scroll: stored.scroll };
  }
  return { list, save, close() { db.close(); } };
}
