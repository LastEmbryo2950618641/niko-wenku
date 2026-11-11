import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, EnvHttpProxyAgent } from 'undici';

const execFileAsync = promisify(execFile);
function checkedProxy(value) {
  if (!value) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : 'http://' + value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch { throw new Error('代理配置无效；只支持 HTTP(S) 代理地址'); }
}
export function resolveNetworkSettings({ proxy = 'auto', env = process.env, systemProxy } = {}) {
  const requestedNoProxy = String(env.no_proxy ?? env.NO_PROXY ?? '').trim();
  const noProxy = requestedNoProxy === '*' ? '*' : [requestedNoProxy, '127.0.0.1', 'localhost', '[::1]'].filter(Boolean).join(',');
  if (proxy === 'direct') return { mode: 'direct', httpProxy: '', httpsProxy: '', noProxy };
  if (proxy !== 'auto') return { mode: 'explicit', httpProxy: checkedProxy(proxy), httpsProxy: checkedProxy(proxy), noProxy };
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  if (http || https) return { mode: 'environment', httpProxy: checkedProxy(http), httpsProxy: checkedProxy(https || http), noProxy };
  if (systemProxy?.enabled && systemProxy.server) {
    const value = systemProxy.server.trim();
    if (!value.includes('=')) return { mode: 'system', httpProxy: checkedProxy(value), httpsProxy: checkedProxy(value), noProxy };
    const protocols = Object.fromEntries(value.split(';').map(entry => entry.trim().split('=').map(part => part.trim())).filter(entry => entry.length === 2));
    if (protocols.http || protocols.https) return { mode: 'system', httpProxy: checkedProxy(protocols.http), httpsProxy: checkedProxy(protocols.https || protocols.http), noProxy };
  }
  return { mode: 'direct', httpProxy: '', httpsProxy: '', noProxy };
}
async function readWindowsProxy() {
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const [enabled, server] = await Promise.all(['ProxyEnable', 'ProxyServer'].map(name => execFileAsync('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 4000 })));
    return { enabled: /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout), server: /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(server.stdout)?.[1]?.trim() || '' };
  } catch { return null; }
}
export async function createNetwork({ proxy = 'auto', env = process.env } = {}) {
  const hasEnvironmentProxy = Boolean(env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY);
  const systemProxy = proxy === 'auto' && !hasEnvironmentProxy && process.platform === 'win32' ? await readWindowsProxy() : null;
  const settings = resolveNetworkSettings({ proxy, env, systemProxy });
  const dispatcher = settings.mode === 'direct' ? new Agent() : new EnvHttpProxyAgent({ httpProxy: settings.httpProxy, httpsProxy: settings.httpsProxy, noProxy: settings.noProxy });
  return { dispatcher, mode: settings.mode, label: { direct: '直连', system: '系统代理', environment: '环境代理', explicit: '指定代理' }[settings.mode] };
}
