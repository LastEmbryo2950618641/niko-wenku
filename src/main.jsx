import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, BookMarked, BookOpen, Check, ChevronDown, Clock3, Copy, Download, FileJson, FolderOpen, HardDrive, LibraryBig, Menu, Plus, RefreshCw, Search, X } from 'lucide-react';
import { BookDetails, Cover, ImportDialog } from './components';
import { appUrl, bytes, date, navigate, readBook, useProgress, useRoute, words } from './lib';
import { AdminAccess, AuthPage, useAdminSession } from './admin';
import './style.css';
import './pagination.css';
import './category-filter.css';
import './cli-download.css';
import { languageLabel } from '../shared/language.mjs';
import WorkerPanel from './worker-panel';

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
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const search = useRef(null);
  const downloadMenu = useRef(null);
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
    function closeDownloadMenu(event) {
      if (!downloadMenu.current?.contains(event.target)) setDownloadMenuOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setDownloadMenuOpen(false);
    }
    document.addEventListener('pointerdown', closeDownloadMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeDownloadMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  useEffect(() => {
    if (route.page !== 'read') document.title = route.page === 'tasks' ? '扫描与下载 · 文库档案' : route.page === 'register' ? '注册账号 · 文库档案' : route.page === 'login' ? '登录 · 文库档案' : admin.public ? '文库档案 · 共享书库' : '文库档案 · 本地书库';
  }, [route.page, admin.public]);
  const categories = catalog.categories || [];
  const isTasks = route.page === 'tasks';
  const canManage = admin.ready && admin.canManage;
  const isPublic = admin.public === true;
  function openImport() { if (canManage) setImportOpen(true); else { navigate('/tasks'); setSidebarOpen(false); } }
  async function logout() { try { await admin.logout(); setImportOpen(false); } catch (reason) { setToast(reason.message); } }
  const filtered = catalog.books;
  const pageCount = catalog.pageCount || 1;
  const currentPage = Math.min(page, pageCount);
  const visibleBooks = catalog.books;
  useEffect(() => { setPage(1); }, [deferredQuery, category, route.page, sort]);
  function changePage(next) { setPage(next); search.current?.closest('.books-section')?.scrollIntoView({ block: 'start' }); }
  const changeSection = page => { navigate('/' + page); setCategory('全部'); setSidebarOpen(false); };
  async function copyPath() {
    try { await navigator.clipboard.writeText(catalog.libraryPath); setToast('书库路径已复制'); }
    catch { setToast(catalog.libraryPath); }
  }
  async function copyNpmInstall() {
    const command = 'npm install -g nikowenku-archive';
    try { await navigator.clipboard.writeText(command); setToast('npm 安装命令已复制'); }
    catch { setToast(command); }
    setDownloadMenuOpen(false);
  }
  if (route.page === 'read') return <Suspense fallback={<div className="full-loading">正在打开阅读器…</div>}><Reader id={route.id} chapterIndex={route.chapter}/></Suspense>;
  return <div className="app">
    {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="收起导航"/>}
    <aside className={'sidebar ' + (sidebarOpen ? 'sidebar-open' : '')}>
      <a className="brand" href="#/library"><span className="brand-icon"><BookOpen size={23} strokeWidth={1.6}/></span><span>文库档案<small>{isPublic ? 'PUBLIC LIBRARY' : 'LOCAL LIBRARY'}</small></span></a>
      <div className="sidebar-label">我的藏书</div>
      <nav className="sidebar-nav">
        <button className={!isRecent && !isCompleted && !isTasks ? 'selected' : ''} onClick={() => changeSection('library')}><LibraryBig size={19}/>全部书籍<span>{loading ? '…' : catalog.stats.total}</span></button>
        <button className={isRecent ? 'selected' : ''} onClick={() => changeSection('recent')}><Clock3 size={19}/>最近阅读<span>{recentIds.length}</span></button>
        <button className={isCompleted ? 'selected' : ''} onClick={() => changeSection('completed')}><BookMarked size={19}/>完结作品<span>{catalog.stats.completed}</span></button>
      </nav>
      <div className="sidebar-label category-label">任务管理</div>
      <nav className="sidebar-nav" aria-label="任务管理"><button className={isTasks ? 'selected' : ''} aria-current={isTasks ? 'page' : undefined} onClick={() => changeSection('tasks')}><Download size={19}/>扫描与下载</button></nav>
      <div className="sidebar-bottom"><div className="local-badge"><HardDrive size={16}/><strong>{isPublic ? '共享书库' : '本地书库'}</strong><span>运行中</span></div><p>{isPublic ? '打开书库，故事随时可读。' : '文件留在本机，故事随时可读。'}</p><button onClick={openImport}><FolderOpen size={16}/>{canManage ? '管理书籍文件' : '管理登录'}<ArrowRight size={15}/></button></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={21}/></button><span className="breadcrumb">{isTasks ? '任务管理' : '我的藏书'} <span>/</span> {isTasks ? '扫描与下载' : isRecent ? '最近阅读' : isCompleted ? '完结作品' : '全部书籍'}</span><div className="topbar-right"><span className="local-indicator"><i/>{isPublic ? '公开书库' : '本地模式'}</span>{admin.enabled && (admin.authenticated ? <div className="admin-account"><span>{admin.username}</span><button className="text-button" onClick={logout}>退出登录</button></div> : <><button className="button secondary" onClick={() => navigate('/login')}>登录</button><button className="button secondary" onClick={() => navigate('/register')}>注册</button></>)}{canManage && <button className="button primary" onClick={openImport}><Plus size={17}/>导入书籍</button>}<div className="cli-download-wrap" ref={downloadMenu}><button className="icon-button topbar-cli-download" type="button" onClick={() => setDownloadMenuOpen(open => !open)} aria-label="打开 CLI 安装选项" aria-expanded={downloadMenuOpen} aria-haspopup="menu" title="CLI 安装选项"><Download size={17}/></button>{downloadMenuOpen && <div className="cli-download-menu" role="menu"><div className="cli-download-menu-title">安装命令行工具</div><a className="cli-download-menu-item" role="menuitem" href={appUrl('/nikowenku-archive-0.1.1.tgz')} download onClick={() => setDownloadMenuOpen(false)}><Download size={16}/><span><strong>下载安装包</strong><small>nikowenku-archive-0.1.1.tgz</small></span></a><button className="cli-download-menu-item" type="button" role="menuitem" onClick={copyNpmInstall}><Copy size={16}/><span><strong>使用 npm 安装</strong><code>npm install -g nikowenku-archive</code></span></button></div>}</div></div></header>
      <main className={'library-main' + (isTasks ? ' worker-main' : '')}>
        {isTasks ? <>
          <section className="page-heading"><div><h1>任务管理<span className="heading-period">.</span></h1><p>查看扫描与下载进度，管理后台任务。</p></div><button className="button secondary" onClick={() => changeSection('library')}><LibraryBig size={16}/>返回书库</button></section>
          <AdminAccess admin={admin}><WorkerPanel onUnauthorized={admin.refresh}/></AdminAccess>
        </> : route.page === 'login' || route.page === 'register' ? <><section className="page-heading"><div><h1>{route.page === 'register' ? '注册账号' : '登录'}<span className="heading-period">.</span></h1><p>账号和密码即可使用。</p></div><button className="button secondary" onClick={() => changeSection('library')}><LibraryBig size={16}/>返回书库</button></section><AuthPage admin={admin} mode={route.page}/></> : <>
        <section className="page-heading"><div><h1>{isRecent ? '继续你的故事' : isCompleted ? '完结书库' : '我的书库'}<span className="heading-period">.</span></h1><p>{isRecent ? '从上次停下的地方，重新走进故事。' : '收好每一页，留住每一个世界。'}</p><a className="cli-inline-link" href={appUrl('/nikowenku-archive-0.1.1.tgz')} download><Download size={14}/>下载命令行工具</a></div><button className="button secondary scan-button" onClick={() => reload(true)} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/>{refreshing ? '正在扫描' : '重新扫描'}</button></section>
        <section className="library-summary" aria-label="书库统计"><div><span>收录作品</span><strong>{catalog.stats.total}<small>本</small></strong></div><div><span>完结作品</span><strong>{catalog.stats.completed}<small>本</small></strong></div><div><span>收录作者</span><strong>{catalog.stats.authors}<small>位</small></strong></div><div><span>本地存储</span><strong className="storage-number">{bytes(catalog.stats.bytes)}</strong></div><div className="summary-note"><span className="summary-icon"><BookOpen size={23} strokeWidth={1.4}/></span><p>每一本，<br/>都有一个值得留下的世界。</p></div></section>
        <div className="library-columns"><section className="books-section">
          <div className="books-tools"><label className="search-field"><Search size={18}/><input ref={search} placeholder="搜索书名、作者、简介或标签" aria-label="搜索书籍" value={query} onChange={event => setQuery(event.target.value)}/>{query ? <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={15}/></button> : <kbd>/</kbd>}</label><label className="sort-field"><select value={sort} onChange={event => setSort(event.target.value)} aria-label="书籍排序"><option value="language">简体中文优先</option><option value="updated">最近更新</option><option value="added">最近入库</option><option value="title">书名顺序</option></select><ChevronDown size={15}/></label></div>
          <div className="results-heading"><h2>{category === '全部' ? isRecent ? '阅读记录' : '全部作品' : category}<span>{catalog.total ?? filtered.length}</span></h2><span>{loading ? '正在加载书库' : catalog.invalidEntries.length ? '有 ' + catalog.invalidEntries.length + ' 份资料待完善' : '索引已同步'}</span></div>
          <nav className="category-filter" aria-label="文库分类">
            <button type="button" aria-pressed={category === '全部'} onClick={() => setCategory('全部')}>全部分类<span>{catalog.stats.total}</span></button>
            {categories.map(([item, count]) => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}<span>{count}</span></button>)}
          </nav>
          {error && <div className="form-error" role="alert">{error}<button className="text-button" onClick={() => reload(true)}>重试</button></div>}
          {loading ? <div className="loading-state">正在加载本地书库…</div> : filtered.length ? <div className="book-grid">{visibleBooks.map(book => <article className="book-card" key={book.id}>
            <button className="book-cover-button" onClick={() => navigate('/book/' + encodeURIComponent(book.id))} aria-label={'查看《' + book.title + '》资料'}><Cover book={book}/></button>
            <div className="book-card-main"><div className="book-card-top"><span className="book-category">{book.category}</span><span className="status-label">{book.completed && <Check size={12}/>} {book.status}</span></div>
            <button className="book-title" onClick={() => navigate('/book/' + encodeURIComponent(book.id))}>{book.title}</button><p className="book-author">{book.author}<span> 著</span></p><p className="book-description">{book.description || '暂无介绍'}</p><div className="book-tags">{book.tags.slice(0, 3).map(tag => <button key={tag} onClick={() => setQuery(tag)}>{tag}</button>)}</div>
            <div className="book-facts"><span>{languageLabel(book.language)}</span><span>{words(book.wordCount)}</span><span>{book.chapterCount ? book.chapterCount + ' 章' : book.formats.join(' / ')}</span><span>{date(book.updatedAt)}</span></div>
            <div className="book-card-actions"><button className="button primary" onClick={() => readBook(book.id, progress[book.id]?.chapter || 0)}><BookOpen size={15}/>{progress[book.id] ? '继续阅读' : '开始阅读'}<ArrowRight size={15}/></button><button className="text-button" onClick={() => navigate('/book/' + encodeURIComponent(book.id))}>书籍详情</button></div></div>
          </article>)}</div> : <div className="empty-state"><BookOpen size={36} strokeWidth={1.3}/><h3>{query || category !== '全部' ? '暂时没有匹配的书籍' : isRecent ? '阅读记录从这里开始' : '这里，等待第一本故事'}</h3><p>{query ? '换个关键词试试，书名、作者和介绍都可以检索。' : isRecent ? '打开任意一本书，章节位置会自动保存在本机。' : '放入一份 JSON 和完整书稿，即可在这里阅读。'}</p><button className="button secondary" onClick={openImport}><Plus size={16}/>导入书籍</button></div>}
          {(catalog.total || 0) > pageSize && <nav className="book-pagination" aria-label="书籍分页"><span>共 {(catalog.total || 0).toLocaleString('zh-CN')} 本 · 每页 {pageSize} 本</span><div><button className="button secondary" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}>上一页</button><span aria-live="polite">{currentPage} / {pageCount}</span><button className="button secondary" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)}>下一页</button></div></nav>}
          {catalog.invalidEntries.length > 0 && <details className="invalid-list"><summary>查看待完善的书籍文件（{catalog.invalidEntries.length}）</summary>{catalog.invalidEntries.map(item => <p key={item.file}><strong>{item.file}</strong>{item.message}</p>)}</details>}
        </section><aside className="library-rail"><div className="rail-note"><span className="rail-icon"><FolderOpen size={23} strokeWidth={1.4}/></span><h3>放入文件，即刻入库</h3><p>一本书，一份 JSON，一份完整正文。页面会自动发现新加入的故事。</p><div className="folder-example"><span><FolderOpen size={15}/>library / my-book</span><span><FileJson size={15}/>book.json <small>书籍资料</small></span><span><BookOpen size={15}/>content.txt <small>完整正文</small></span></div><button className="button secondary" onClick={openImport}>查看导入方式<ArrowRight size={15}/></button></div><section className="cli-download"><div><Download size={17}/><h3>命令与 Codex Skill</h3></div><p>面向以轻小说为主的书库，提供命令行搜索、查看详情与下载。</p><a className="button secondary" href={appUrl('/nikowenku-archive-0.1.1.tgz')} download><Download size={15}/>下载 CLI 安装包 <span>.tgz</span></a><a className="button secondary" href={appUrl('/nico-cli-0.1.0.tgz')} download><Download size={15}/>下载 nico-cli 工具箱 <span>.tgz</span></a><button className="button secondary cli-copy-command" type="button" onClick={copyNpmInstall}><Copy size={15}/>复制 npm 安装命令</button><a className="button secondary" href={appUrl('/nikowenku-archive-skill.md')} download><Download size={15}/>下载 Codex Skill</a><code>npm install -g nikowenku-archive</code><small>需要 Node.js 22 或更新版本</small></section><div className="rail-location"><span className="muted-label">书库所在位置</span><code>{catalog.libraryPath || 'library/'}</code><button onClick={copyPath}><Copy size={14}/>复制路径</button></div><div className="rail-sync"><span className="sync-mark"><Check size={13}/></span><span>每 5 秒自动发现新书<br/><small>无需重新构建或重启服务</small></span></div></aside></div>
        <footer className="page-footer"><span>文库档案</span><p>以文件为书架，以阅读为归处。</p><span>{catalog.scannedAt ? '最近扫描 ' + new Date(catalog.scannedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '正在扫描'}</span></footer>
        </>}
      </main>
    </div>
    {importOpen && canManage && <ImportDialog libraryPath={catalog.libraryPath} onClose={() => setImportOpen(false)} onPublished={title => { setImportOpen(false); void reload(true); setToast('《' + title + '》已发布到书库'); }}/>}
    {route.page === 'book' && route.id && <BookDetails id={route.id} progress={progress[route.id]} onClose={() => navigate('/library')}/>}
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
