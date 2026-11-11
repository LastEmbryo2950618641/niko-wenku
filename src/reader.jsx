import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Download, List, Minus, Moon, Plus, Search, Sun, X } from 'lucide-react';
import { appUrl, api, bookUrl, navigate, readBook, readStore, words, writeStore } from './lib';
import { readingParagraphs } from './reading-text';

export default function Reader({ id, chapterIndex }) {
  const [book, setBook] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState(() => readStore('reader-settings', { theme: 'paper', size: 19 }));
  const scrollRestored = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    setBook(null); setError('');
    api(bookUrl(id), { signal: abort.signal }).then(setBook).catch(reason => { if (!abort.signal.aborted) setError(reason.message); });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    scrollRestored.current = false;
    setChapter(null); setError('');
    api(bookUrl(id) + '/chapters/' + chapterIndex, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      setChapter(result);
      setTocOpen(false);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason.message); });
    return () => abort.abort();
  }, [id, chapterIndex]);
  useEffect(() => {
    if (!chapter || !book) return;
    document.title = chapter.title + ' · ' + book.title;
    const progress = readStore('progress', {});
    const old = progress[id];
    const scroll = old?.chapter === chapterIndex ? old.scroll || 0 : 0;
    requestAnimationFrame(() => {
      window.scrollTo(0, scroll);
      scrollRestored.current = true;
    });
    progress[id] = { chapter: chapterIndex, title: chapter.title, visitedAt: Date.now(), scroll };
    writeStore('progress', progress);
    let timer;
    const save = () => {
      if (!scrollRestored.current) return;
      const current = readStore('progress', {});
      current[id] = { chapter: chapterIndex, title: chapter.title, visitedAt: Date.now(), scroll: window.scrollY };
      writeStore('progress', current);
    };
    const onScroll = () => { clearTimeout(timer); timer = setTimeout(save, 250); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(timer); save(); window.removeEventListener('scroll', onScroll); };
  }, [chapter, book, id, chapterIndex]);
  useEffect(() => { writeStore('reader-settings', settings); }, [settings]);
  useEffect(() => {
    function shortcut(event) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (event.key === 'ArrowRight' && book && chapterIndex < book.chapters.length - 1) readBook(id, chapterIndex + 1);
      if (event.key === 'ArrowLeft' && chapterIndex > 0) readBook(id, chapterIndex - 1);
      if (event.key === 'Escape') setTocOpen(false);
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [book, id, chapterIndex]);
  return <div className={'reader reader-theme-' + settings.theme}>
    <header className="reader-topbar"><button className="text-button" onClick={() => navigate('/library')}><ArrowLeft size={18}/><span>返回书库</span></button><div className="reader-identity"><BookOpen size={17}/><span>{book?.title || '正在打开书籍'}</span></div><div className="reader-controls"><button className="icon-button" onClick={() => setSettings({ ...settings, size: Math.max(15, settings.size - 1) })} title="缩小字号" aria-label="缩小字号"><Minus size={16}/></button><span className="font-size-label">{settings.size}</span><button className="icon-button" onClick={() => setSettings({ ...settings, size: Math.min(28, settings.size + 1) })} title="放大字号" aria-label="放大字号"><Plus size={16}/></button><span className="control-separator"/><button className="icon-button" onClick={() => setSettings({ ...settings, theme: settings.theme === 'night' ? 'paper' : 'night' })} title="切换阅读主题" aria-label="切换阅读主题">{settings.theme === 'night' ? <Sun size={18}/> : <Moon size={18}/>}</button><button className="icon-button reader-toc-toggle" onClick={() => setTocOpen(!tocOpen)} title="章节目录" aria-label="章节目录"><List size={20}/></button></div></header>
    {tocOpen && <button className="reader-scrim" onClick={() => setTocOpen(false)} aria-label="关闭目录遮罩"/>}
    <aside className={'reader-toc ' + (tocOpen ? 'toc-open' : '')}><header><h2>目录</h2><span>{book?.chapters.length || 0} 章</span><button className="icon-button close-toc" onClick={() => setTocOpen(false)} aria-label="关闭目录"><X size={18}/></button></header><label className="toc-search"><Search size={15}/><input placeholder="搜索章节" aria-label="搜索章节" value={query} onChange={event => setQuery(event.target.value)}/></label><nav>{book?.chapters.filter(item => item.title.includes(query)).map(item => <button key={item.index} className={item.index === chapterIndex ? 'current-chapter' : ''} onClick={() => readBook(id, item.index)}><small>{String(item.index + 1).padStart(2, '0')}</small><span>{item.volume && <em>{item.volume}</em>}{item.title}</span></button>)}</nav>{book && <a className="toc-download" href={appUrl(book.downloadUrl)}><Download size={16}/>下载完整原文</a>}</aside>
    <main className="reader-main">
      {error ? <section className="reader-error"><h1>暂时无法打开这本书</h1><p>{error}</p><button className="button secondary" onClick={() => navigate('/library')}>返回书库</button></section> : !chapter ? <div className="loading-state">正在载入正文…</div> : <div className="reader-sheet"><div className="reader-overline">{book?.author || '本地书库'}<span>{chapterIndex + 1} / {chapter.total}</span></div>{chapter.volume && <p className="reader-volume">{chapter.volume}</p>}<h1>{chapter.title}</h1><p className="reader-chapter-info">{words(chapter.wordCount)}<span>左右方向键切换章节</span></p><article className="reader-text" style={{ fontSize: settings.size + 'px' }}>{readingParagraphs(chapter.content).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article><div className="chapter-navigation"><button className="button secondary" disabled={chapterIndex === 0} onClick={() => readBook(id, chapterIndex - 1)}><ChevronLeft size={17}/>上一章</button><span>{chapterIndex + 1} / {chapter.total}</span><button className="button primary" disabled={chapterIndex >= chapter.total - 1} onClick={() => readBook(id, chapterIndex + 1)}>下一章<ChevronRight size={17}/></button></div></div>}
    </main>
  </div>;
}
