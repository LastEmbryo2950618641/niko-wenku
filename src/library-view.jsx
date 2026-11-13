import { Fragment, useState } from 'react';
import { ArrowDownWideNarrow, BookCheck, BookHeart, BookOpen, Check, CircleAlert, CircleCheck, Copy, Download, FolderOpen, HardDrive, Heart, Layers, LibraryBig, LoaderCircle, MoreHorizontal, MoveLeft, MoveRight, PawPrint, PenLine, RefreshCw, ScrollText, Search, Sparkles, Terminal, WandSparkles, X } from 'lucide-react';
import { Cover, Modal } from './components';
import { LaceDivider, PawTrail, RibbonBow, StoryEmblem } from './library-ornaments';
import { appUrl, bytes, navigate, readBook, words } from './lib';

export function LibraryBrand({ compact = false, onClick }) {
  return <a className={'library-brand' + (compact ? ' library-brand-compact' : '')} href="#/library" onClick={onClick} aria-label="文库档案首页">
    <span className="brand-portrait"><img src={appUrl('/brand/mascot.png')} alt="" width="48" height="48"/></span>
    <span className="library-brand-copy"><strong>文库档案<Sparkles className="brand-sparkle" size={12} aria-hidden="true"/></strong><small>LIGHT NOVEL LIBRARY</small></span>
    <LaceDivider className="brand-lace"/>
  </a>;
}

export function CliInstallDialog({ onClose, onCopy }) {
  const [copied, setCopied] = useState(null);
  return <Modal title="安装命令行工具" onClose={onClose}>
    <p className="modal-intro">搜索轻小说、查看书籍资料、下载全文。Windows、Linux 和 macOS 均可使用，需要 Node.js 22 或更新版本。</p>
    <div className="install-options">
      <section><span className="install-option-icon"><Download size={21}/></span><div><h3>下载安装包</h3><p>适合离线安装，将安装包保存到本机后执行：</p><a className="button primary" href={appUrl('/nikowenku-archive-0.1.1.tgz')} download><Download size={15}/>下载 .tgz 安装包</a><code>npm install -g --offline ./nikowenku-archive-0.1.1.tgz</code></div></section>
      <section><span className="install-option-icon"><Terminal size={21}/></span><div><h3>使用 npm 安装</h3><p>在终端执行下方命令，从 npm 安装独立 CLI。</p><button className="install-copy" onClick={async () => setCopied(await onCopy())}><code>npm install -g nikowenku-archive</code>{copied ? <Check size={16}/> : <Copy size={16}/>}<span className="visually-hidden">复制 npm 安装命令</span></button>{copied !== null && <p className="install-copy-status" role="status">{copied ? '安装命令已复制' : '未能自动复制，请手动选择上方命令。'}</p>}</div></section>
    </div>
    <details className="install-skill"><summary><Sparkles size={15} aria-hidden="true"/>AI Skill 与更多工具</summary><p>Skill 同时包含命令说明书，可供 AI 阅读和调用。</p><a className="text-link" href={appUrl('/nikowenku-archive-skill.md')} download><Download size={15}/>下载 Codex Skill</a><a className="text-link" href={appUrl('/nico-cli-0.1.0.tgz')} download><Download size={15}/>下载 nico-cli 工具箱</a></details>
  </Modal>;
}

function BookTile({ book, progress, onTag, index }) {
  const openDetails = () => navigate('/book/' + encodeURIComponent(book.id));
  const charm = book.id.charCodeAt(book.id.length - 1) % 3;
  return <article className="shelf-book" style={{ '--tile-order': Math.min(index, 7) }}>
    <div className="shelf-book-cover">
      <button className="shelf-cover-link" onClick={openDetails} aria-label={'查看《' + book.title + '》资料'}><Cover book={book}/><span className={'shelf-status ' + (book.completed ? 'is-complete' : '')}>{book.completed ? <Check size={10}/> : <i/>}{book.status || (book.completed ? '已完结' : '连载中')}</span></button>
      <span className="shelf-book-paw" aria-hidden="true">{charm === 0 ? <RibbonBow/> : charm === 1 ? <Heart size={17}/> : <PawPrint size={17}/>}</span>
      <button className="shelf-read" onClick={() => readBook(book.id, progress?.chapter || 0)} aria-label={(progress ? '继续阅读《' : '开始阅读《') + book.title + '》'} title={progress ? '继续阅读' : '开始阅读'}><BookOpen size={17}/></button>
    </div>
    <button className="shelf-book-title" onClick={openDetails} title={book.title}>{book.title}</button>
    <p className="shelf-book-author" title={book.author}>{book.author || '佚名'}<span> · 著</span></p>
    <div className="shelf-book-tags">{(book.tags || []).slice(0, 3).map(tag => <button key={tag} onClick={() => onTag(tag)}>{tag}</button>)}</div>
    <div className="shelf-book-facts"><span><ScrollText size={12} aria-hidden="true"/>{words(book.wordCount)}</span><span><Layers size={12} aria-hidden="true"/>{book.chapterCount ? book.chapterCount + ' 章' : (book.formats || []).join(' / ')}</span></div>
  </article>;
}

function Pagination({ current, count, total, pageSize, onChange }) {
  if (count <= 1) return null;
  const pages = [...new Set([1, ...[current - 1, current, current + 1].filter(value => value > 1 && value < count), count])];
  return <nav className="shelf-pagination" aria-label="书籍分页">
    <span className="shelf-pagination-note"><BookOpen size={14} aria-hidden="true"/>共 {total.toLocaleString('zh-CN')} 本 · 每页 {pageSize} 本</span>
    <div className="shelf-page-controls">
      <button className="shelf-page-turn" aria-label="上一页" title="上一页" disabled={current <= 1} onClick={() => onChange(current - 1)}><MoveLeft size={18} aria-hidden="true"/></button>
      {pages.map((value, index) => <Fragment key={value}>
        {index > 0 && value - pages[index - 1] > 1 && <span className="shelf-page-gap"><MoreHorizontal size={16} aria-hidden="true"/><span className="visually-hidden">省略页码</span></span>}
        <span className={'shelf-page-item' + (value !== 1 && value !== count && value !== current ? ' shelf-page-neighbor' : '')}><button aria-label={'第 ' + value + ' 页'} aria-current={value === current ? 'page' : undefined} onClick={() => onChange(value)}>{value === current && <PawPrint className="shelf-page-paw" size={13} aria-hidden="true"/>}<span>{value}</span></button></span>
      </Fragment>)}
      <button className="shelf-page-turn" aria-label="下一页" title="下一页" disabled={current >= count} onClick={() => onChange(current + 1)}><MoveRight size={18} aria-hidden="true"/></button>
    </div>
    <PawTrail className="shelf-pagination-trail"/>
  </nav>;
}

export function LibraryShelf({ catalog, loading, error, query, onQuery, category, onCategory, sort, onSort, searchRef, isRecent, isCompleted, refreshing, onRefresh, onImport, onInstall, progress, page, pageSize, onPage, onRandom, randomBusy }) {
  const number = value => (value || 0).toLocaleString('zh-CN');
  const stats = [
    { label: '收录作品', value: number(catalog.stats.total), unit: '本', Icon: LibraryBig },
    { label: '完结作品', value: number(catalog.stats.completed), unit: '本', Icon: BookCheck },
    { label: '收录作者', value: number(catalog.stats.authors), unit: '位', Icon: PenLine },
    { label: '本地存储', value: bytes(catalog.stats.bytes).split(' ')[0], unit: bytes(catalog.stats.bytes).split(' ')[1], Icon: HardDrive },
  ];
  const total = catalog.total || 0;
  const title = category !== '全部' ? category : isRecent ? '阅读记录' : isCompleted ? '完结作品' : '全部作品';
  return <>
    <section className="shelf-hero">
      <div className="shelf-intro"><div className="shelf-hero-copy"><h1><span className="shelf-heading-icon" aria-hidden="true"><BookHeart/></span>{isRecent ? '继续你的故事' : isCompleted ? '完结书库' : '我的书库'}<span>。</span></h1>
      <p>{isRecent ? '从上次停下的地方，重新走进故事。' : <>收好每一页，留住每一个世界。<span><b>{number(catalog.stats.total)}</b> 本轻小说，等你翻开。</span></>}</p></div><StoryEmblem/></div>
      <LaceDivider className="shelf-stats-lace"/>
      <div className="shelf-stats" aria-label="书库统计">{stats.map(({ label, value, unit, Icon }) => <div key={label}><span><Icon size={14}/>{label}</span><strong>{loading ? '—' : value}<small>{unit}</small></strong></div>)}</div>
      <div className="shelf-actions"><button className="button secondary" onClick={onRefresh} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/>{refreshing ? '正在扫描' : '重新扫描'}</button><button className="button secondary" onClick={onInstall}><Terminal size={15}/>下载命令行工具</button><button className="button secondary" onClick={onImport}><FolderOpen size={15}/>放入文件，即刻入库</button></div>
    </section>
    <section className="shelf-catalog" aria-label="浏览书库" aria-busy={loading}>
      <div className="shelf-tools"><label className="shelf-search"><Search size={18}/><input ref={searchRef} type="search" placeholder="搜索书名、作者、简介或标签" aria-label="搜索书籍" value={query} onChange={event => onQuery(event.target.value)}/>{query ? <button onClick={() => onQuery('')} aria-label="清除搜索"><X size={16}/></button> : <kbd>/</kbd>}</label><div className="shelf-tools-side"><label className="shelf-sort"><ArrowDownWideNarrow size={15} aria-hidden="true"/><select value={sort} onChange={event => onSort(event.target.value)} aria-label="书籍排序"><option value="language">简体中文优先</option><option value="updated">最近更新</option><option value="added">最近入库</option><option value="title">书名顺序</option></select></label><button className="button secondary shelf-random" onClick={onRandom} disabled={!total || randomBusy}>{randomBusy ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <WandSparkles size={16} aria-hidden="true"/>}{randomBusy ? '正在挑选…' : '随机翻开一本'}</button></div></div>
      <nav className="shelf-categories" aria-label="文库分类"><button aria-pressed={category === '全部'} onClick={() => onCategory('全部')}>{category === '全部' ? <RibbonBow/> : <LibraryBig size={13}/>}全部作品<small>{number(catalog.stats.total)}</small></button>{(catalog.categories || []).map(([item, count]) => <button key={item} aria-pressed={category === item} onClick={() => onCategory(item)}>{category === item ? <RibbonBow/> : <BookOpen size={13}/>}<span>{item}</span><small>{number(count)}</small></button>)}</nav>
      <div className="shelf-results"><h2><PawPrint size={16} aria-hidden="true"/>{title}</h2><span>{catalog.books.length} / {number(total)}</span><small role="status">{loading ? <LoaderCircle size={12} className="spin" aria-hidden="true"/> : catalog.invalidEntries.length ? <CircleAlert size={12} className="shelf-index-warning" aria-hidden="true"/> : <CircleCheck size={12} aria-hidden="true"/>}{loading ? '正在整理书架' : catalog.invalidEntries.length ? catalog.invalidEntries.length + ' 份资料待完善' : '索引已同步'}</small></div>
      {error && <div className="form-error" role="alert">{error}<button className="text-button" onClick={onRefresh}>重试</button></div>}
      {loading ? <div className="shelf-skeleton" aria-label="正在加载书库">{Array.from({ length: 6 }, (_, index) => <div key={index}/>)}</div> : catalog.books.length ? <div className="shelf-grid" key={catalog.books.map(book => book.id).join('|')}>{catalog.books.map((book, index) => <BookTile key={book.id} book={book} index={index} progress={progress[book.id]} onTag={onQuery}/>)}</div> : <div className="empty-state"><span className="shelf-empty-icon" aria-hidden="true"><PawPrint size={36}/><Sparkles size={18}/><RibbonBow/></span><h3>{query || category !== '全部' ? '暂时没有匹配的书籍' : isRecent ? '阅读记录从这里开始' : '这里，等待第一本故事'}</h3><p>{query || category !== '全部' ? '换个关键词或分类试试。' : isRecent ? '打开任意一本书，章节位置会自动保存在本机。' : '放入一份 JSON 和完整书稿，即可在这里阅读。'}</p>{query || category !== '全部' ? <button className="button secondary" onClick={() => { onQuery(''); onCategory('全部'); }}>清除筛选</button> : !isRecent && <button className="button secondary" onClick={onImport}><FolderOpen size={16}/>导入书籍</button>}</div>}
      <Pagination current={page} count={catalog.pageCount || 1} total={total} pageSize={pageSize} onChange={onPage}/>
      {catalog.invalidEntries.length > 0 && <details className="invalid-list"><summary>查看待完善的书籍文件（{catalog.invalidEntries.length}）</summary>{catalog.invalidEntries.map(item => <p key={item.file}><strong>{item.file}</strong>{item.message}</p>)}</details>}
    </section>
    <LaceDivider className="shelf-footer-lace"/>
    <footer className="shelf-footer"><span><BookHeart size={15} aria-hidden="true"/>文库档案</span><p>以文件为书架，以阅读为归处。</p><PawTrail/><small>{catalog.scannedAt ? '最近扫描 ' + new Date(catalog.scannedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '正在扫描'}</small></footer>
  </>;
}
