import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookMarked, BookOpen, Check, Clock3, Download, House, LibraryBig, LogIn, LogOut, Menu, MoonStar, PawPrint, Plus, Sparkles, UserPlus, UserRound, X } from 'lucide-react';
import { AdminAccess, AuthPage } from './admin';
import { BookDetails, ImportDialog } from './components';
import { api, navigate } from './lib';
import { CliInstallDialog, LibraryBrand, LibraryShelf } from './library-view';
import { PawTrail } from './library-ornaments';
import WorkerPanel from './worker-panel';

export function LibraryShell({ route, admin, catalog, loading, error, query, onQuery, category, onCategory, sort, onSort, searchRef, isRecent, isCompleted, recentIds, refreshing, onRefresh, importOpen, setImportOpen, onImport, onPublished, sidebarOpen, setSidebarOpen, changeSection, progress, page, pageSize, onPage, toast, setToast }) {
  const [installOpen, setInstallOpen] = useState(false);
  const [randomBusy, setRandomBusy] = useState(false);
  const sidebar = useRef(null);
  const isTasks = route.page === 'tasks';
  const isAuth = route.page === 'login' || route.page === 'register';
  const canManage = admin.ready && admin.canManage;
  const isPublic = admin.public === true;
  const sectionTitle = isTasks ? '扫描与下载' : isAuth ? route.page === 'register' ? '注册账号' : '登录' : isRecent ? '最近阅读' : isCompleted ? '完结作品' : '全部书籍';
  useEffect(() => {
    if (!sidebarOpen) return;
    const before = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const controls = () => [...sidebar.current.querySelectorAll('a[href], button:not([disabled])')].filter(node => node.getClientRects().length);
    controls()[0]?.focus();
    const keydown = event => {
      if (event.key === 'Escape') { setSidebarOpen(false); return; }
      if (event.key !== 'Tab') return;
      const items = controls();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); before?.focus(); };
  }, [sidebarOpen, setSidebarOpen]);
  async function logout() { try { await admin.logout(); setImportOpen(false); } catch (reason) { setToast(reason.message); } }
  async function copyNpmInstall() {
    const command = 'npm install -g nikowenku-archive';
    try { await navigator.clipboard.writeText(command); return true; }
    catch { return false; }
  }
  async function openRandom() {
    if (randomBusy || !catalog.total) return;
    setRandomBusy(true);
    try {
      const params = new URLSearchParams({ page: String(1 + Math.floor(Math.random() * catalog.total)), pageSize: '1', q: query.trim().toLocaleLowerCase(), category: category === '全部' ? '' : category, sort: isRecent ? 'recent' : sort });
      if (isCompleted) params.set('completed', '1');
      if (isRecent) { params.set('recent', '1'); params.set('recentIds', recentIds.join(',')); }
      const result = await api('/api/library?' + params);
      if (result.books?.[0]) navigate('/book/' + encodeURIComponent(result.books[0].id));
      else setToast('书架已变化，请刷新后再试');
    } catch (reason) { setToast(reason.message); }
    finally { setRandomBusy(false); }
  }
  return <div className="app library-app">
    <div className="library-backdrop" aria-hidden="true"/>
    {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="收起导航"/>}
    <aside ref={sidebar} className={'sidebar ' + (sidebarOpen ? 'sidebar-open' : '')} aria-label="书库导航" role={sidebarOpen ? 'dialog' : undefined} aria-modal={sidebarOpen ? true : undefined}>
      <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"><X size={18}/></button>
      <LibraryBrand onClick={() => setSidebarOpen(false)}/>
      <div className="sidebar-label"><BookOpen size={13} aria-hidden="true"/>我的藏书<PawTrail/></div>
      <nav className="sidebar-nav" aria-label="我的藏书">
        <button className={!isRecent && !isCompleted && !isTasks && !isAuth ? 'selected' : ''} aria-current={!isRecent && !isCompleted && !isTasks && !isAuth ? 'page' : undefined} onClick={() => changeSection('library')}><LibraryBig size={18}/>全部书籍<span>{loading ? '…' : catalog.stats.total.toLocaleString('zh-CN')}</span></button>
        <button className={isRecent ? 'selected' : ''} aria-current={isRecent ? 'page' : undefined} onClick={() => changeSection('recent')}><Clock3 size={18}/>最近阅读<span>{recentIds.length}</span></button>
        <button className={isCompleted ? 'selected' : ''} aria-current={isCompleted ? 'page' : undefined} onClick={() => changeSection('completed')}><BookMarked size={18}/>完结作品<span>{catalog.stats.completed.toLocaleString('zh-CN')}</span></button>
      </nav>
      <div className="sidebar-label category-label"><Sparkles size={13} aria-hidden="true"/>任务管理</div>
      <nav className="sidebar-nav" aria-label="任务管理"><button className={isTasks ? 'selected' : ''} aria-current={isTasks ? 'page' : undefined} onClick={() => changeSection('tasks')}><Download size={18}/>扫描与下载<span className="sidebar-live-dot"/></button></nav>
      <div className="sidebar-bottom"><div className="library-mode"><strong><MoonStar size={16} aria-hidden="true"/>{isPublic ? '共享书库' : '本地书库'}</strong><PawPrint className="library-mode-paw" size={42} aria-hidden="true"/><p>{isPublic ? '打开书库，故事随时可读。' : '文件留在本机，故事随时可读。'}</p></div><button onClick={onImport}><UserRound size={16}/>{canManage ? '管理书籍文件' : '管理登录'}<ArrowRight size={15}/></button><a className="library-home-link" href="/"><House size={14} aria-hidden="true"/>返回网站收藏<ArrowRight size={13}/></a></div>
    </aside>
    <div className="workspace" inert={sidebarOpen ? true : undefined}>
      <header className="topbar"><div className="mobile-brand"><LibraryBrand compact/></div><span className="breadcrumb"><LibraryBig size={14}/><b>{isTasks ? '任务管理' : '我的藏书'}</b><span>/</span>{sectionTitle}</span><div className="topbar-right"><span className="local-indicator"><PawPrint size={14} aria-hidden="true"/>{isPublic ? '公开书库' : '本地模式'}</span>{admin.enabled && (admin.authenticated ? <div className="admin-account"><span>{admin.username}</span><button className="text-button" onClick={logout}><LogOut size={14} aria-hidden="true"/>退出登录</button></div> : <><button className="button secondary" onClick={() => navigate('/login')}><LogIn size={14} aria-hidden="true"/>登录</button><button className="button primary" onClick={() => navigate('/register')}><UserPlus size={14} aria-hidden="true"/>注册</button></>)}{canManage && <button className="button primary topbar-import" onClick={onImport}><Plus size={15}/>导入书籍</button>}<button className="icon-button topbar-cli-download" type="button" onClick={() => setInstallOpen(true)} aria-label="打开 CLI 安装选项" title="安装命令行工具"><Download size={17}/></button><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={20}/></button></div></header>
      <main key={isTasks ? 'tasks' : isAuth ? route.page : isRecent ? 'recent' : isCompleted ? 'completed' : 'library'} className={'library-main' + (isTasks ? ' worker-main' : '')}>
        {isTasks ? <><section className="page-heading"><div><h1>任务管理<span className="heading-period">。</span></h1><p>查看扫描与下载进度，管理后台任务。</p></div><button className="button secondary" onClick={() => changeSection('library')}><LibraryBig size={16}/>返回书库</button></section><AdminAccess admin={admin}><WorkerPanel onUnauthorized={admin.refresh}/></AdminAccess></> : isAuth ? <><section className="page-heading"><div><h1>{sectionTitle}<span className="heading-period">。</span></h1><p>打开书库，继续你的故事。</p></div><button className="button secondary" onClick={() => changeSection('library')}><LibraryBig size={16}/>返回书库</button></section><AuthPage admin={admin} mode={route.page}/></> : <LibraryShelf catalog={catalog} loading={loading} error={error} query={query} onQuery={onQuery} category={category} onCategory={onCategory} sort={sort} onSort={onSort} searchRef={searchRef} isRecent={isRecent} isCompleted={isCompleted} refreshing={refreshing} onRefresh={onRefresh} onImport={onImport} onInstall={() => setInstallOpen(true)} progress={progress} page={page} pageSize={pageSize} onPage={onPage} onRandom={openRandom} randomBusy={randomBusy}/>}
      </main>
    </div>
    {installOpen && <CliInstallDialog onClose={() => setInstallOpen(false)} onCopy={copyNpmInstall}/>}
    {importOpen && canManage && <ImportDialog libraryPath={catalog.libraryPath} onClose={() => setImportOpen(false)} onPublished={onPublished}/>}
    {route.page === 'book' && route.id && <BookDetails id={route.id} progress={progress[route.id]} onClose={() => navigate('/library')}/>}
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
  </div>;
}
