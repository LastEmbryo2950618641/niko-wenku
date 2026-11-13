import { readFile, writeFile, copyFile, mkdir, realpath, rm, rename, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
async function atomicWrite(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.new-' + process.pid;
  try { await writeFile(temp, content, { mode }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

export async function configureReadFailover({ sitePath, nginxRoot = '/etc/nginx', validate = () => exec('/usr/sbin/nginx', ['-t']), reload = () => exec('systemctl', ['reload', 'nginx']) }) {
  // Resolve the enabled-site symlink; never replace it or overwrite other sites.
  sitePath = await realpath(sitePath);
  const original = await readFile(sitePath, 'utf8');
  const marker = /    # BEGIN wenku read failover[\s\S]*?    # END wenku read failover\r?\n(?:\r?\n)?/g;
  const clean = original.replace(marker, '');
  const anchors = [...clean.matchAll(/^([ \t]*)location = \/nikowenku-archive \{/gm)];
  if (anchors.length !== 1) throw new Error('需要唯一的 /nikowenku-archive 站点入口，未修改配置');
  const anchor = anchors[0];
  const block = '    # BEGIN wenku read failover\n    include ' + join(nginxRoot, 'snippets/niko-wenku-read-locations.conf').replaceAll('\\', '/') + ';\n    # END wenku read failover\n\n';
  const updated = clean.slice(0, anchor.index) + block + clean.slice(anchor.index);
  const changes = [{ path: sitePath, content: updated }];
  for (const [from, to] of [
    ['nginx-read-upstream.conf', 'conf.d/niko-wenku-read-upstream.conf'],
    ['nginx-read-proxy.conf', 'snippets/niko-wenku-read-proxy.conf'],
    ['nginx-read-locations.conf', 'snippets/niko-wenku-read-locations.conf']
  ]) {
    changes.push({ path: join(nginxRoot, to), content: (await readFile(join(source, from), 'utf8')).replaceAll('/etc/nginx/', nginxRoot.replaceAll('\\', '/') + '/') });
  }
  for (const item of changes) {
    try { item.before = await readFile(item.path); item.mode = (await stat(item.path)).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Keep a persistent recovery copy; its suffix is not loaded by conf.d/*.conf.
  const backupSuffix = '.before-read-failover-' + Date.now();
  for (const item of changes) if (item.before) await copyFile(item.path, item.path + backupSuffix);
  let reloading = false;
  try {
    for (const item of changes) await atomicWrite(item.path, item.content, item.mode);
    await validate();
    reloading = true;
    await reload();
  } catch (error) {
    for (const item of changes) {
      if (item.before) await atomicWrite(item.path, item.before, item.mode);
      else await rm(item.path, { force: true });
    }
    if (reloading) { await validate(); await reload(); }
    throw error;
  }
  return { sitePath, backupSuffix };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('请在 Linux 服务器上使用 sudo 运行');
  if (!process.argv[2]) throw new Error('用法：sudo node deploy/configure-read-failover.mjs /etc/nginx/sites-enabled/worldseed');
  console.log(JSON.stringify(await configureReadFailover({ sitePath: process.argv[2] })));
}
