import { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, KeyRound, Play, RefreshCw, ScanLine, Search, Square, Trash2, Upload, X } from 'lucide-react';
import { api } from './lib';
import { ciweimaoAccessNotice } from './ciweimao-notice';
import './ciweimao-notice.css';
import './ciweimao-panel.css';

const labels = { starting: '正在启动', syncing: '正在同步', idle: '等待更新', stopping: '正在停止', stopped: '已停止', access_required: '需要人工验证', error: '任务异常' };
const bookLabels = { pending: '等待同步', synced: '已同步', failed: '同步失败', empty: '暂无免费正文' };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
export default function CiweimaoPanel({ onUnauthorized }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [auth, setAuth] = useState(null), [cookieHeader, setCookieHeader] = useState(''), [authFile, setAuthFile] = useState('');
  const [query, setQuery] = useState(''), [results, setResults] = useState(null), [bookId, setBookId] = useState('');
  const revision = useRef(0), refresh = useRef(() => {}), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let disposed = false, timer, request;
    async function poll() {
      if (disposed || request) return;
      const version = revision.current;
      request = new AbortController();
      try {
        const next = await api('/api/worker/ciweimao/status', { signal: request.signal });
        if (!disposed && version === revision.current) setState(next);
      } catch (reason) { if (!disposed && reason.name !== 'AbortError') { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
      finally { request = null; if (!disposed) timer = window.setTimeout(poll, 2000); }
    }
    refresh.current = () => { window.clearTimeout(timer); void poll(); };
    void poll();
    return () => { disposed = true; mounted.current = false; window.clearTimeout(timer); request?.abort(); };
  }, [onUnauthorized]);
  async function refreshAuth() {
    try { const next = await api('/api/worker/ciweimao/auth'); if (mounted.current) setAuth(next); }
    catch (reason) { if (mounted.current && reason.status === 401) void onUnauthorized?.(); }
  }
  useEffect(() => { void refreshAuth(); }, []);
  async function action(name, payload = {}) {
    if (busy) return;
    revision.current++; setBusy(name); setError('');
    try {
      const next = await api('/api/worker/ciweimao/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify(payload) });
      if (mounted.current) { revision.current++; setState(next); if (name === 'add') setBookId(''); }
    } catch (reason) { if (mounted.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
    finally { if (mounted.current) { setBusy(''); refresh.current(); } }
  }
  async function search(event) {
    event.preventDefault(); if (busy || !query.trim()) return;
    setBusy('search'); setError('');
    try { const found = await api('/api/worker/ciweimao/search?q=' + encodeURIComponent(query.trim())); if (mounted.current) setResults(found.books); }
    catch (reason) { if (mounted.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
    finally { if (mounted.current) setBusy(''); }
  }
  async function importAuth(event) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget;
    setBusy('auth-import'); setError('');
    try {
      const payload = cookieHeader.trim() ? { cookieHeader: cookieHeader.trim() } : authFile;
      if (!payload || typeof payload !== 'object') throw new Error('请粘贴 Cookie Header 或选择 Cookie JSON 文件');
      const next = await api('/api/worker/ciweimao/auth/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify(payload) });
      if (mounted.current) { setAuth(next); setCookieHeader(''); setAuthFile(''); form.reset(); }
      if (mounted.current) { setBusy('auth-check'); await checkAuthRequest(); }
    } catch (reason) { if (mounted.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
    finally { if (mounted.current) setBusy(''); }
  }
  async function readAuthFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try { const text = await file.text(); const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object') throw new Error('JSON 文件格式不正确'); setAuthFile(parsed); setCookieHeader(''); }
    catch (reason) { setAuthFile(''); setError(reason.message || 'Cookie JSON 文件读取失败'); }
  }
  async function clearAuth() {
    if (busy) return;
    setBusy('auth-clear'); setError('');
    try { const next = await api('/api/worker/ciweimao/auth/clear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: '{}' }); if (mounted.current) setAuth(next); }
    catch (reason) { if (mounted.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
    finally { if (mounted.current) setBusy(''); }
  }
  async function checkAuthRequest() {
    const next = await api('/api/worker/ciweimao/auth/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: '{}' });
    if (mounted.current) setAuth(next);
  }
  async function checkAuth() {
    if (busy) return;
    setBusy('auth-check'); setError('');
    try { await checkAuthRequest(); }
    catch (reason) { if (mounted.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
    finally { if (mounted.current) setBusy(''); }
  }
  const current = state?.lanes?.download, updating = state?.lanes?.update, scan = state?.scan, update = state?.update;
  const accessNotice = ciweimaoAccessNotice(state);
  const running = state?.running, ids = new Set(state?.books?.map(book => book.id));
  return <section className="worker-panel ciweimao-panel" aria-label="刺猬猫免费章节同步管理">
    <div className="worker-heading"><div className="worker-title"><BookOpen size={20}/><h2>刺猬猫免费章节同步管理</h2><span className={'worker-status' + (running ? ' is-running' : '')}><i/>{busy === 'start' ? '正在启动' : labels[state?.status] || '读取状态'}</span></div><div className="worker-controls"><button className="button secondary" disabled={!state || busy || running || (!state.queued && !state.autoDiscover)} onClick={() => action('start')}><Play size={14}/>启动同步</button><button className="button secondary" disabled={!running || busy} onClick={() => action('stop')}><Square size={14}/>停止同步</button></div></div>
    {accessNotice && <div className="worker-notice ciweimao-access-notice" role="alert"><strong>{accessNotice.title}</strong><p>{accessNotice.message}</p>{accessNotice.url && <a href={accessNotice.url} target="_blank" rel="noopener noreferrer">{accessNotice.linkText}</a>}</div>}
    {!accessNotice && state?.message && <p className="worker-notice">{state.message}</p>}
    <p className="ciweimao-intro">启动后自动扫描刺猬猫书库，发现作品即下载免费章节并归入“刺猬猫免费章节”。已入库作品每 {Math.round((state?.intervalSeconds || 1800) / 60)} 分钟检查更新。</p>
    <div className="ciweimao-auth">
      <div className="ciweimao-auth-heading"><div><KeyRound size={16}/><strong>登录状态</strong><span>{auth?.configured ? `已保存 ${auth.count} 个未过期 Cookie` : '未配置'}</span></div>
        {auth?.configured && <div className="ciweimao-auth-actions"><button className="text-button" type="button" disabled={!!busy || !!running} onClick={checkAuth}><RefreshCw size={13}/>{busy === 'auth-check' ? '检测中…' : '检测可用性'}</button><button className="text-button" type="button" disabled={!!busy} onClick={clearAuth}><Trash2 size={13}/>清除</button></div>}
      </div>
      <p>在官网完成登录及书库翻页验证后导入 Cookie Header 或 Cookie JSON。保存后自动检测书库访问；检测不会启动扫描或下载，任务运行时请先停止再检测。内容仅保存到本机私有状态目录，不返回 Cookie 原文。</p>
      <form onSubmit={importAuth} className="ciweimao-auth-form"><textarea value={cookieHeader} onChange={event => { setCookieHeader(event.target.value); setAuthFile(''); }} placeholder="Cookie Header，例如：a=b; c=d" maxLength={1024 * 1024} aria-label="刺猬猫 Cookie Header"/><label className="ciweimao-auth-file"><Upload size={14}/><span>{authFile ? '已选择 Cookie JSON' : '选择 Cookie JSON'}</span><input type="file" accept="application/json,.json" onChange={readAuthFile}/></label><button className="button secondary" type="submit" disabled={!!busy || (!cookieHeader.trim() && !authFile)}>{busy === 'auth-import' ? '保存中' : '保存登录状态'}</button></form>
      {auth?.configured && <small className="ciweimao-auth-meta">域名：{auth.domains.join('、')} · 最后更新：{auth.updatedAt ? time(auth.updatedAt) : '未知'}</small>}
      <div className={'ciweimao-auth-check is-' + (busy === 'auth-check' ? 'checking' : auth?.verification?.status || 'unchecked')} role="status" aria-live="polite">
        {busy === 'auth-check' ? '正在使用已保存 Cookie 检测官网书库访问…' : auth?.verification?.message || (auth?.configured ? '已保存，尚未确认官网访问是否可用。' : '尚未导入登录状态。')}
        {busy !== 'auth-check' && auth?.verification?.checkedAt && <small>检测时间：{time(auth.verification.checkedAt)} · 上方任务状态仍保留最近一次运行结果，检测成功后可手动启动同步。</small>}
      </div>
    </div>
    <div className="worker-lanes ciweimao-lanes">
      <div className="worker-lane"><div className="worker-lane-label"><ScanLine size={16}/><h3>自动扫描</h3><span>{scan?.active ? '正在扫描' : state?.autoDiscover ? '已开启' : '已关闭'}</span></div><div className="worker-current"><strong>{scan?.active ? '正在读取书库第 ' + scan.nextPage + ' 页' : '下次从第 ' + (scan?.nextPage || 1) + ' 页继续'}</strong><span>{scan?.message || (scan?.nextCheckAt ? '下一轮：' + time(scan.nextCheckAt) : '按官网书库分页发现作品，断点自动保存')}</span></div><progress aria-label="刺猬猫书库扫描进度" value={scan?.processedPages || 0} max={scan?.totalPages || 1}/><div className="worker-progress-note"><span>已扫描 {scan?.processedPages || 0} / {scan?.totalPages || '未知'} 页</span><span>已发现 {scan?.discovered || 0} 本</span></div></div>
      <div className="worker-lane"><div className="worker-lane-label"><Download size={16}/><h3>自动下载免费章节</h3><span>{current?.total ? `${current.completed || 0} / ${current.total} 章` : running ? '等待作品' : '未运行'}</span></div><div className="worker-current"><strong>{current?.title || '等待扫描发现新作品'}</strong><span>{current?.phase === 'cover' ? '正在同步封面' : current?.chapterTitle || (current?.phase === 'publishing' ? '正在上架到文库' : '自动跳过收费章节，已保存章节会校验复用')}</span></div><progress aria-label="刺猬猫免费章节同步进度" value={current?.completed || 0} max={current?.total || 1}/><div className="worker-progress-note"><span>待下载 {state?.pending || 0} 本</span><span>本书收费跳过 {current?.skipped || 0} 章</span></div></div>
    </div>
    <div className="worker-lane worker-update-lane"><div className="worker-update-heading"><div className="worker-lane-label"><RefreshCw size={16}/><h3>自动检查与更新</h3></div><span className="worker-update-state">{updating ? updating.phase === 'catalog' ? '正在检查' : updating.phase === 'cover' ? '正在同步封面' : '正在更新' : running ? '等待下次检查' : '已停止'}</span></div><div className="worker-update-current"><strong>{updating?.title || '已入库作品持续检查，有新免费章节自动更新'}</strong></div><progress aria-label="刺猬猫作品更新进度" value={updating?.completed || 0} max={updating?.total || 1}/><div className="worker-update-stats"><div><span>本次已检查</span><strong>{update?.checked || 0}</strong></div><div><span>已是最新</span><strong>{update?.upToDate || 0}</strong></div><div><span>正在更新</span><strong>{update?.pending || 0}</strong></div><div><span>已经更新</span><strong>{update?.updated || 0}</strong></div></div></div>
    <div className="worker-footer"><div><span>已上架 <b>{state?.published || 0}</b> 本</span><span>失败 <b>{state?.failed || 0}</b> 本</span></div><span>扫描、下载和更新共用请求间隔 1.5 秒</span></div>
    <details className="ciweimao-manual"><summary>手动添加指定作品</summary>
    <div className="ciweimao-forms">
      <form onSubmit={search}><label htmlFor="ciweimao-query">书名或作者</label><div><input id="ciweimao-query" value={query} onChange={event => setQuery(event.target.value)} maxLength={100} placeholder="搜索刺猬猫作品"/><button className="button secondary" disabled={!!busy || !query.trim()}><Search size={14}/>{busy === 'search' ? '搜索中' : '搜索'}</button></div></form>
      <form onSubmit={event => { event.preventDefault(); void action('add', { bookId: bookId.trim() }); }}><label htmlFor="ciweimao-id">已有作品链接或 ID</label><div><input id="ciweimao-id" value={bookId} onChange={event => setBookId(event.target.value)} maxLength={500} placeholder="https://www.ciweimao.com/book/…"/><button className="button secondary" disabled={!!busy || !bookId.trim()}>加入同步</button></div></form>
    </div>
    {results !== null && <div className="ciweimao-results"><h3>搜索结果</h3>{results.length ? results.map(book => <div key={book.id}><span><a href={book.url} target="_blank" rel="noreferrer">{book.title}</a><small>{book.author} · {book.id}</small></span><button className="button secondary" disabled={!!busy || ids.has(book.id)} onClick={() => action('add', { bookId: book.id })}>{ids.has(book.id) ? '已加入' : '加入同步'}</button></div>) : <p>未找到相关作品，请换一个关键词。</p>}</div>}
    </details>
    {error && <div className="form-error worker-error" role="alert">{error}</div>}
    <div className="ciweimao-queue"><h3>最近发现与同步 <small>共 {state?.queued || 0} 本，显示最近 100 本</small></h3>{state?.books?.length ? state.books.map(book => <div key={book.id}><span><a href={'https://www.ciweimao.com/book/' + book.id} target="_blank" rel="noreferrer">{book.title}</a><small>{bookLabels[book.status] || '处理中'} · {book.status === 'synced' ? `${book.completed} 章 · ` : ''}{book.message || time(book.checkedAt)}</small></span><button className="icon-button" disabled={!!busy || current?.id === book.id || updating?.id === book.id} onClick={() => action('remove', { bookId: book.id })} aria-label={'移出同步队列：' + book.title} title="停止同步此作品，保留已上架书籍"><X size={16}/></button></div>) : <p>启动后自动从书库发现作品。</p>}</div>
  </section>;
}
