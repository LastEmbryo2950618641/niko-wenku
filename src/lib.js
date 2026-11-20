import { useEffect, useState } from 'react';

export function appUrl(path) {
  const prefix = import.meta.env.BASE_URL.replace(/\/$/, '');
  return path?.startsWith('/') && !(prefix && path.startsWith(prefix + '/')) ? prefix + path : path;
}
export async function api(path, options) {
  const response = await fetch(appUrl(path), options);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '请求失败'); error.status = response.status; throw error; }
  return result;
}
export const bookUrl = id => appUrl('/api/books/' + encodeURIComponent(id));
export function bytes(value) {
  if (value < 1024) return value + ' B';
  return value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(2) + ' MB';
}
export function words(value) {
  return !value ? '待索引' : value < 10000 ? value.toLocaleString('zh-CN') + ' 字' : (value / 10000).toFixed(1) + ' 万字';
}
export function date(value) {
  if (!value) return '未提供';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '.');
}
export function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem('wenku:v1:' + key)) ?? fallback; }
  catch { return fallback; }
}
export function writeStore(key, value) {
  try { localStorage.setItem('wenku:v1:' + key, JSON.stringify(value)); }
  catch { /* Reading still works if browser storage is unavailable. */ }
  window.dispatchEvent(new Event('archive-storage'));
}
export function useProgress() {
  const [progress, setProgress] = useState(() => readStore('progress', {}));
  useEffect(() => {
    const update = () => setProgress(readStore('progress', {}));
    window.addEventListener('archive-storage', update);
    return () => window.removeEventListener('archive-storage', update);
  }, []);
  return progress;
}
export function saveReadingProgress(id, entry) {
  return api('/api/reading-progress', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify({ bookId: id, chapter: entry.chapter, title: entry.title || '', scroll: entry.scroll || 0, visitedAt: entry.visitedAt }) });
}
export async function syncReadingProgress() {
  const remote = await api('/api/reading-progress');
  const server = remote.progress || {};
  const local = readStore('progress', {});
  let changed = false;
  for (const [id, entry] of Object.entries(server)) {
    if (!local[id] || (entry.visitedAt || 0) >= (local[id].visitedAt || 0)) {
      local[id] = entry;
      changed = true;
    }
  }
  if (changed) writeStore('progress', local);
  await Promise.all(Object.entries(local).filter(([id, entry]) => !server[id] || (entry.visitedAt || 0) > (server[id].visitedAt || 0)).slice(0, 500).map(([id, entry]) => saveReadingProgress(id, entry).catch(() => {})));
}
export function navigate(path) { window.location.hash = path; }
export function useRoute() {
  const getRoute = () => {
    const parts = window.location.hash.replace(/^#\/?/, '').split('/');
    try { return { page: parts[0] || 'library', id: decodeURIComponent(parts[1] || ''), chapter: Math.max(0, Number(parts[2]) || 0) }; }
    catch { return { page: 'library', id: '', chapter: 0 }; }
  };
  const [route, setRoute] = useState(getRoute);
  useEffect(() => { const update = () => setRoute(getRoute()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  return route;
}
export function readBook(id, chapter = 0) { navigate('/read/' + encodeURIComponent(id) + '/' + chapter); }
