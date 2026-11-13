import { useEffect, useRef, useState } from 'react';
import { Download, Play, RefreshCw, ScanLine, Square } from 'lucide-react';
import { api, bytes } from './lib';
import './worker-panel.css';
import { RibbonBow } from './library-ornaments';

const statusLabels = { downloading: '运行中', discovering: '运行中', processing: '运行中', idle: '等待新任务', paused: '已暂停', auth_required: '需要登录', cooldown: '限速等待', stopped: '已停止', stopping: '正在停止', starting: '正在启动', not_started: '尚未启动', config_error: '配置有误', unavailable: '未配置后台任务' };
const phaseLabels = { preparing: '准备下载', metadata: '读取书籍资料', download_page: '读取全本下载入口', text: '接收全本文本', validating: '校验正文', cover: '保存封面', publishing: '写入本地书库' };
const number = value => (value || 0).toLocaleString('zh-CN');
const shortId = value => String(value || '').replace(/^wenku8-/, '');
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '尚无记录';

export default function WorkerPanel({ onUnauthorized }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const revision = useRef(0);
  const refresh = useRef(() => {});
  useEffect(() => {
    let disposed = false, timer, request;
    async function poll() {
      if (disposed || request) return;
      if (document.hidden) { timer = window.setTimeout(poll, 2000); return; }
      const currentRevision = revision.current;
      request = new AbortController();
      try {
        const next = await api('/api/worker/status', { signal: request.signal });
        if (!disposed && currentRevision === revision.current) { setState(next); setError(''); }
      } catch (reason) { if (!disposed && reason.name !== 'AbortError' && currentRevision === revision.current) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); } }
      finally { request = null; if (!disposed) timer = window.setTimeout(poll, 2000); }
    }
    refresh.current = () => { window.clearTimeout(timer); void poll(); };
    const visible = () => { if (!document.hidden) refresh.current(); };
    document.addEventListener('visibilitychange', visible);
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [onUnauthorized]);
  async function control(action) {
    if (busy) return;
    revision.current++;
    setBusy(action); setError('');
    try {
      const next = await api('/api/worker/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: '{}' });
      revision.current++;
      setState(next);
    } catch (reason) { setError(reason.message); if (reason.status === 401) void onUnauthorized?.(); }
    finally { setBusy(''); refresh.current(); }
  }
  const scan = state?.scan, download = state?.download;
  const update = state?.update, updateWorker = state?.updateWorker;
  const scanning = scan?.current?.[0], current = download?.current?.[0], transfer = current?.transfer;
  const running = state?.running, status = busy === 'start' ? 'starting' : busy === 'stop' ? 'stopping' : state?.status;
  const scanPercent = scan?.total ? Math.min(100, scan.processed / scan.total * 100) : 0;
  const updatePercent = update?.total ? Math.min(100, update.checked / update.total * 100) : 0;
  const activeTransfer = running && current && !state.stopping;
  const unknownTransfer = activeTransfer && (!transfer || transfer.percent == null);
  const downloadText = !running ? '断点已保留，启动后继续' : current ? phaseLabels[transfer?.phase] || '等待请求间隔' : '等待扫描发现可下载书籍';
  const available = state?.available;
  return <section className="worker-panel" aria-labelledby="worker-heading" aria-busy={!!busy}>
    <div className="worker-heading">
      <div className="worker-title"><h2 id="worker-heading"><RibbonBow/>扫描与下载</h2><span className={'worker-status ' + (running && !['auth_required', 'cooldown', 'config_error'].includes(status) ? 'is-running' : '')} role="status"><i/>{state || busy ? statusLabels[status] || '运行中' : '正在连接后台'}</span></div>
      <div className="worker-controls">
        <button className="button primary" onClick={() => control('start')} disabled={!available || running || !!busy}>{busy === 'start' ? <RefreshCw size={14} className="spin"/> : <Play size={14}/>} {busy === 'start' ? '正在启动' : '启动任务'}</button>
        <button className="button secondary" onClick={() => control('stop')} disabled={!available || !running || !!busy}>{busy === 'stop' ? <RefreshCw size={14} className="spin"/> : <Square size={13}/>} {busy === 'stop' ? '正在停止' : '停止任务'}</button>
      </div>
    </div>
    <div className="worker-lanes">
      <div className="worker-lane">
        <div className="worker-lane-label"><ScanLine size={16}/><h3>编号扫描</h3><span>{scan?.total ? scanPercent.toFixed(1) + '%' : '等待任务'}</span></div>
        <div className="worker-current"><strong>{scanning ? '正在扫描 #' + shortId(scanning.id) : running && state?.discovery?.status === 'checking' ? '正在检查最新书籍编号' : running ? '等待扫描任务' : '扫描已停止'}</strong><span>{scanning && scanning.title !== scanning.id ? scanning.title : scan?.nextId ? '续扫编号 #' + scan.nextId : scan?.total ? '当前编号范围已扫描完毕' : '从保存的断点开始'}</span></div>
        <progress aria-label="编号扫描进度" value={scan?.processed || 0} max={scan?.total || 1}/>
        <div className="worker-progress-note"><span>已检查 <b>{number(scan?.processed)}</b> / {number(scan?.total)}</span><span>发现 {number(scan?.completed)} 本</span></div>
      </div>
      <div className="worker-lane">
        <div className="worker-lane-label"><Download size={16}/><h3>全文下载</h3><span>{activeTransfer && transfer?.percent != null ? transfer.percent.toFixed(1) + '%' : activeTransfer ? '处理中' : '等待任务'}</span></div>
        <div className="worker-current"><strong>{current ? current.title : running ? '等待下载任务' : '下载已停止'}</strong><span>{current ? '#' + shortId(current.id) + ' · ' : ''}{downloadText}</span></div>
        <progress aria-label="当前全文下载进度" {...(unknownTransfer ? {} : { value: activeTransfer ? transfer?.receivedBytes || 0 : 0 })} max={transfer?.totalBytes || (activeTransfer ? Math.max(transfer?.receivedBytes || 0, 1) : 1)}/>
        <div className="worker-progress-note"><span>{activeTransfer && transfer?.receivedBytes ? bytes(transfer.receivedBytes) + (transfer.totalBytes ? ' / ' + bytes(transfer.totalBytes) : ' · 总大小未知') : '任务随扫描持续加入'}</span><span>待下载 <b>{number(download?.pending)}</b> 本</span></div>
      </div>
    </div>
    <div className="worker-lane worker-update-lane">
      <div className="worker-update-heading"><div className="worker-lane-label"><RefreshCw size={16}/><h3>书籍更新</h3></div><span className="worker-update-state">{updateWorker?.current?.[0]?.updateCheck ? '正在检测' : updateWorker?.current?.[0]?.updating ? '正在更新' : update?.pending ? '等待更新' : running && update?.total && update?.checked >= update.total ? '本轮完成' : running ? '等待检查' : '已停止'}</span></div>
      <div className="worker-update-current"><strong>{updateWorker?.current?.[0]?.title ? '《' + updateWorker.current[0].title + '》' : update?.pending ? '有 ' + number(update.pending) + ' 本书等待更新' : running && update?.total && update?.checked >= update.total ? '本轮书籍检查完成' : running ? '正在检查已入库书籍' : '启动后检查已入库书籍'}</strong></div>
      <progress aria-label="书籍更新检测进度" value={update?.checked || 0} max={update?.total || 1}/>
      <div className="worker-update-stats">
        <div><span>已检查</span><strong>{number(update?.checked)}<small> / {number(update?.total)}</small></strong></div>
        <div><span>已是最新</span><strong>{number(update?.upToDate)}</strong></div>
        <div><span>需更新</span><strong>{number(update?.pending)}</strong></div>
        <div><span>已经更新</span><strong>{number(update?.updated)}</strong></div>
      </div>
    </div>
    <div className="worker-footer"><div><span>已上架 <b>{number(state?.progress?.published)}</b></span><span>缺失 <b>{number(state?.progress?.missing)}</b></span><span>失败 <b>{number(state?.progress?.failed)}</b></span></div><span>请求间隔 {state?.interval?.minSeconds ?? 3}–{state?.interval?.maxSeconds ?? 8} 秒</span></div>
    {state?.discovery?.enabled && <div className="worker-discovery"><strong>新编号发现</strong><span>{state.discovery.status === 'checking' && running ? '正在检查' : state.discovery.message || '已开启'}</span><span>已发现至 #{number(state.discovery.knownMaxId)}</span>{state.discovery.nextCheckAt && running && <span>下次 {time(state.discovery.nextCheckAt)}</span>}</div>}
    {state?.needsAuthentication && <p className="worker-notice">登录态需要更新。请更新本机 Cookie 文件，后台会自动恢复。</p>}
    {state?.status === 'cooldown' && <p className="worker-notice">站点要求限速，等待至 {time(state.cooldownUntil)} 后自动继续。</p>}
    {state?.status === 'config_error' && <p className="worker-notice">任务配置暂不可读取，请检查本机下载队列文件。</p>}
    {error && <div className="form-error worker-error" role="alert">{error}<button className="text-button" onClick={() => refresh.current()}>重新连接</button></div>}
    <details className="worker-details"><summary>最近任务记录<span>{time(state?.heartbeatAt)}</span></summary><ul>{state?.activity?.length ? state.activity.map(item => <li key={item.id}><time>{time(item.at)}</time><span>{item.title}</span><em>{item.status === 'published' ? item.updated ? '已更新' : '已上架' : item.status === 'discovered' ? '资料已保存' : item.status === 'failed' ? '失败' : item.status === 'missing' ? '来源缺失' : '处理中'}{item.code ? ' · ' + item.code : ''}</em></li>) : <li>暂无任务记录</li>}</ul></details>
  </section>;
}
