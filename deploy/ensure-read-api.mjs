import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function usable(baseUrl, timeoutMs) {
  try {
    const healthResponse = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!healthResponse.ok) return false;
    const health = await healthResponse.json();
    if (health.ok !== true || health.readOnly !== true) return false;
    const catalogResponse = await fetch(baseUrl + '/api/library?pageSize=1', { signal: AbortSignal.timeout(timeoutMs) });
    if (!catalogResponse.ok) return false;
    const catalog = await catalogResponse.json();
    return Array.isArray(catalog.books) && Number.isSafeInteger(catalog.total) && catalog.total >= 0;
  } catch { return false; }
}

export async function ensureReadApi({ serviceUser, libraryRoot, publicOrigin, sitePath, baseUrl = 'http://127.0.0.1:4179', timeoutMs = 2000, install } = {}) {
  if (await usable(baseUrl, timeoutMs)) {
    console.log('备用服务可用，跳过部署、重启和配置修改。');
    return { action: 'skipped' };
  }
  console.log('备用服务不可用，重新部署并启用只读服务。');
  if (install) await install();
  else {
    if (![serviceUser, libraryRoot, publicOrigin, sitePath].every(value => typeof value === 'string' && value)) throw new Error('修复备用服务需要用户名、书库路径、公开 origin 和 Nginx 配置路径');
    await new Promise((done, reject) => {
      const child = spawn('bash', [fileURLToPath(new URL('./install-read-api.sh', import.meta.url)), serviceUser, libraryRoot, publicOrigin, sitePath], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? done() : reject(new Error('备用服务安装失败，退出码：' + code)));
    });
  }
  if (!await usable(baseUrl, timeoutMs)) throw new Error('重新部署后备用服务仍不可用，停止本次发布');
  console.log('备用服务已恢复，健康与书目读取检查通过。');
  return { action: 'repaired' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('请在 Linux 服务器上使用 sudo 运行');
  if (process.argv.length !== 6) throw new Error('用法：sudo node deploy/ensure-read-api.mjs SERVICE_USER LIBRARY_ROOT PUBLIC_ORIGIN NGINX_SITE');
  const [serviceUser, libraryRoot, publicOrigin, sitePath] = process.argv.slice(2);
  console.log(JSON.stringify(await ensureReadApi({ serviceUser, libraryRoot, publicOrigin, sitePath })));
}
