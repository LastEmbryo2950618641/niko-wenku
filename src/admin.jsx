import { useCallback, useEffect, useRef, useState } from 'react';
import { api, appUrl, navigate } from './lib';
import './admin.css';
import { RibbonBow } from './library-ornaments';

export function useAdminSession() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setSession(await api('/api/auth/session')); setError(''); }
    catch (reason) { setError(reason.message); }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [refresh]);
  async function authenticate(mode, payload) {
    const next = await api('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify(payload) });
    setSession(next); setError('');
    return next;
  }
  async function logout() {
    const next = await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: '{}' });
    setSession(next);
  }
  return { ...session, ready: !!session, error, refresh, authenticate, logout };
}

export function AuthPage({ admin, mode = 'login', management = false }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const captchaRequest = useRef(null);
  const register = mode === 'register';
  const refreshCaptcha = useCallback(async () => {
    captchaRequest.current?.abort();
    const controller = new AbortController();
    captchaRequest.current = controller;
    setRefreshing(true); setCaptcha(''); setChallenge(null);
    try { const next = await api('/api/auth/captcha?purpose=' + mode, { signal: controller.signal }); if (!controller.signal.aborted) setChallenge(next); }
    catch (reason) { if (reason.name !== 'AbortError') setError(reason.message); }
    finally { if (!controller.signal.aborted) setRefreshing(false); }
  }, [mode]);
  useEffect(() => {
    setError(''); setPassword('');
    if (admin.enabled && !admin.authenticated) void refreshCaptcha();
    return () => captchaRequest.current?.abort();
  }, [mode, admin.enabled, admin.authenticated, refreshCaptcha]);
  if (!admin.ready) return <div className="admin-card"><p>{admin.error || '正在确认管理登录状态…'}</p>{admin.error && <button className="button secondary" onClick={admin.refresh}>重新连接</button>}</div>;
  if (admin.authenticated) return <section className="admin-card"><h2>已登录</h2><p>{admin.username}，欢迎回来。</p><button className="button primary" onClick={() => navigate('/library')}>返回书库</button>{admin.canManage && <button className="text-button" onClick={() => navigate('/tasks')}>任务管理</button>}</section>;
  async function submit(event) {
    event.preventDefault();
    if (busy || !challenge) return;
    setBusy(true); setError('');
    try {
      const next = await admin.authenticate(mode, { username: username.trim(), password, captchaId: challenge.id, captcha });
      setPassword(''); setCaptcha(''); navigate(management && next.canManage ? '/tasks' : '/library');
    } catch (reason) { setError(reason.message); await refreshCaptcha(); }
    finally { setBusy(false); }
  }
  return <section className="admin-card" aria-labelledby="admin-heading">
    <h2 id="admin-heading"><RibbonBow/>{register ? '注册账号' : management ? '管理登录' : '登录'}</h2>
    <p>{register ? '填写账号、密码和图片验证码即可注册。' : '书库可直接阅读，管理任务需要管理员登录。'}</p>
    <form onSubmit={submit}>
      <label htmlFor="auth-username">账号<input id="auth-username" name="username" autoComplete="username" maxLength={64} value={username} onChange={event => setUsername(event.target.value)} required disabled={busy}/></label>
      <label htmlFor="auth-password">密码<input id="auth-password" name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : undefined} maxLength={1024} placeholder={register ? '至少 8 个字符' : undefined} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/></label>
      <label htmlFor="auth-captcha">图片验证码<div className="captcha-row"><input id="auth-captcha" name="captcha" inputMode="numeric" autoComplete="off" maxLength={5} value={captcha} onChange={event => setCaptcha(event.target.value)} required disabled={busy}/><button type="button" className="captcha-image" onClick={refreshCaptcha} disabled={busy || refreshing} aria-label="刷新验证码">{challenge ? <img src={appUrl(challenge.imageUrl)} alt="五位数字验证码"/> : <span>{refreshing ? '正在加载…' : '点击重试'}</span>}</button></div></label>
      <span className="captcha-hint">看不清？点击图片换一张。</span>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={busy || !challenge || refreshing}>{busy ? '正在提交…' : register ? '注册' : '登录'}</button>
    </form>
    <p className="auth-switch">{register ? '已有账号？' : '还没有账号？'}<a href={register ? '#/login' : '#/register'}>{register ? '去登录' : '注册账号'}</a></p>
  </section>;
}

export function AdminAccess({ admin, children }) {
  if (admin.ready && admin.canManage) return children;
  if (admin.authenticated) return <section className="admin-card"><h2>仅限管理员</h2><p>当前账号可以阅读书库，扫描、下载和导入需要管理员账号。</p><button className="button secondary" onClick={admin.logout}>退出并切换账号</button></section>;
  return <AuthPage admin={admin} management/>;
}
