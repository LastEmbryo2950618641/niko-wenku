import { useCallback, useEffect, useState } from 'react';
import { api } from './lib';
import './admin.css';

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
  async function login(username, password) {
    const next = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify({ username, password }) });
    setSession(next); setError('');
  }
  async function logout() {
    const next = await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: '{}' });
    setSession(next);
  }
  return { ...session, ready: !!session, error, refresh, login, logout };
}

export function AdminAccess({ admin, children }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!admin.ready) return <div className="admin-card"><p>{admin.error || '正在确认管理登录状态…'}</p>{admin.error && <button className="button secondary" onClick={admin.refresh}>重新连接</button>}</div>;
  if (admin.authenticated) return children;
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await admin.login(username.trim(), password); setPassword(''); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  return <section className="admin-card" aria-labelledby="admin-heading">
    <h2 id="admin-heading">管理登录</h2>
    <p>登录后可管理扫描、下载和书籍导入。书库阅读无需登录。</p>
    <form onSubmit={submit}>
      <label htmlFor="admin-username">账号<input id="admin-username" name="username" autoComplete="username" maxLength={64} value={username} onChange={event => setUsername(event.target.value)} required disabled={busy}/></label>
      <label htmlFor="admin-password">密码<input id="admin-password" name="password" type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
    </form>
  </section>;
}
