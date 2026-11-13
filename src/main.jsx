import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { appUrl, navigate, useProgress, useRoute } from './lib';
import { useAdminSession } from './admin';
import './style.css';
import { LibraryShell } from './library-shell';
import './library-theme.css';
import './library-ornaments.css';
import './library-skins.css';

const Reader = lazy(() => import('./reader'));
const initialCatalog = { books: [], categories: [], invalidEntries: [], stats: { total: 0, completed: 0, authors: 0, bytes: 0 }, total: 0, pageCount: 1 };
const pageSize = 24;

function App() {
  const route = useRoute();
  const admin = useAdminSession();
  const [catalog, setCatalog] = useState(initialCatalog);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [sort, setSort] = useState('language');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState('');
  const search = useRef(null);
  const catalogRequest = useRef(null);
  const catalogEtag = useRef({ key: '', value: '' });
  const progress = useProgress();
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const isRecent = route.page === 'recent';
  const isCompleted = route.page === 'completed';
  const recentIds = useMemo(() => Object.entries(progress).sort((a, b) => (b[1]?.visitedAt || 0) - (a[1]?.visitedAt || 0)).map(([id]) => id).slice(0, 500), [progress]);
  const reload = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q: deferredQuery, category: category === '全部' ? '' : category, sort: isRecent ? 'recent' : sort });
    if (isCompleted) params.set('completed', '1');
    if (isRecent) { params.set('recent', '1'); params.set('recentIds', recentIds.join(',')); }
    if (manual) params.set('refresh', '1');
    const keyParams = new URLSearchParams(params);
    keyParams.delete('refresh');
    const key = keyParams.toString();
    if (!manual && catalogRequest.current?.key === key) return;
    catalogRequest.current?.controller.abort();
    const request = { key, controller: new AbortController(), promise: null };
    catalogRequest.current = request;
    request.promise = (async () => {
    try {
      const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]);
      const etag = catalogEtag.current.key === key ? catalogEtag.current.value : '';
      const response = await fetch(appUrl('/api/library?' + params), { signal, headers: etag && !manual ? { 'If-None-Match': etag } : {} });
      if (catalogRequest.current !== request) return;
      if (response.status !== 304) {
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || '书库加载失败');
        catalogEtag.current = { key, value: response.headers.get('ETag') || '' };
        setCatalog(next);
      }
      setError('');
    }
    catch (reason) { if (reason.name !== 'AbortError') setError(reason.name === 'TimeoutError' ? '书目加载超时，请点击重试。已显示的书籍仍可阅读。' : reason.message); }
    finally { setLoading(false); if (manual) setRefreshing(false); }
    })();
    try { await request.promise; }
    finally { if (catalogRequest.current === request) catalogRequest.current = null; }
  }, [page, deferredQuery, category, isRecent, isCompleted, recentIds, sort]);
  useEffect(() => {
    void reload();
    const interval = window.setInterval(() => { if (!document.hidden) void reload(); }, 5000);
    return () => { window.clearInterval(interval); catalogRequest.current?.controller.abort(); };
  }, [reload]);
  useEffect(() => {
    function shortcut(event) {
      const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (((event.metaKey || event.ctrlKey) && event.key === 'k') || (event.key === '/' && !editable)) {
        if (route.page !== 'read' && route.page !== 'tasks') { event.preventDefault(); search.current?.focus(); }
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [route.page]);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (route.page !== 'read') document.title = route.page === 'tasks' ? '扫描与下载 · 文库档案' : route.page === 'register' ? '注册账号 · 文库档案' : route.page === 'login' ? '登录 · 文库档案' : admin.public ? '文库档案 · 共享书库' : '文库档案 · 本地书库';
  }, [route.page, admin.public]);
  const canManage = admin.ready && admin.canManage;
  function openImport() { if (canManage) setImportOpen(true); else { navigate('/tasks'); setSidebarOpen(false); } }
  const pageCount = catalog.pageCount || 1;
  const currentPage = Math.min(page, pageCount);
  useEffect(() => { setPage(1); }, [deferredQuery, category, route.page, sort]);
  function changePage(next) { setPage(next); search.current?.closest('.shelf-catalog')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
  const changeSection = page => { navigate('/' + page); setCategory('全部'); setSidebarOpen(false); };
  if (route.page === 'read') return <Suspense fallback={<div className="full-loading">正在打开阅读器…</div>}><Reader id={route.id} chapterIndex={route.chapter}/></Suspense>;
  return <LibraryShell route={route} admin={admin} catalog={catalog} loading={loading} error={error} query={query} onQuery={setQuery} category={category} onCategory={setCategory} sort={sort} onSort={setSort} searchRef={search} isRecent={isRecent} isCompleted={isCompleted} recentIds={recentIds} refreshing={refreshing} onRefresh={() => reload(true)} importOpen={importOpen} setImportOpen={setImportOpen} onImport={openImport} onPublished={title => { setImportOpen(false); void reload(true); setToast('《' + title + '》已发布到书库'); }} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} changeSection={changeSection} progress={progress} page={currentPage} pageSize={pageSize} onPage={changePage} toast={toast} setToast={setToast}/>;
}
createRoot(document.getElementById('root')).render(<App/>);
