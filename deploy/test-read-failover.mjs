// Linux integration check: runs an isolated nginx with disposable upstreams.
// It never stops/restarts/reconfigures the production nginx, API or worker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createAppServer } from '../server/app.mjs';

if (process.platform !== 'linux') throw new Error('Run on Linux with nginx installed');
const base = await mkdtemp(join(tmpdir(), 'wenku-failover-'));
let nginx, backup, primary;
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});
const close = server => server?.listening ? new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) : Promise.resolve();
try {
  const libraryRoot = join(base, 'library');
  await mkdir(join(libraryRoot, 'book'), { recursive: true });
  const text = Buffer.from('第一章 备用服务\n主备服务必须返回相同的完整正文。\n');
  await writeFile(join(libraryRoot, 'book/book.json'), JSON.stringify({ id: 'book', title: '故障切换测试', files: { text: 'content.txt' } }));
  await writeFile(join(libraryRoot, 'book/content.txt'), text);
  backup = await createAppServer({ libraryRoot, readOnly: true, stateDir: join(base, 'state') });
  const backupPort = await listen(backup);
  let mode = 200, primaryHits = 0;
  primary = createServer((req, res) => {
    primaryHits++;
    if (mode === 'timeout') return;
    if (mode !== 200) { res.writeHead(mode); return res.end('simulated primary failure'); }
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, readOnly: false })); }
    if (req.url === '/api/books/book/files/text') { res.setHeader('Content-Length', text.length); return res.end(text); }
    res.writeHead(404); res.end('not found');
  });
  const primaryPort = await listen(primary);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  for (const file of ['upstream', 'proxy', 'locations']) {
    let config = await readFile(new URL('./nginx-read-' + file + '.conf', import.meta.url), 'utf8');
    config = config.replaceAll('127.0.0.1:4178', '127.0.0.1:' + primaryPort).replaceAll('127.0.0.1:4179', '127.0.0.1:' + backupPort)
      .replaceAll('/etc/nginx/snippets/niko-wenku-read-proxy.conf', base + '/proxy.conf');
    await writeFile(join(base, file + '.conf'), config);
  }
  const configPath = join(base, 'nginx.conf');
  await writeFile(configPath, `pid ${base}/nginx.pid;
error_log ${base}/error.log warn;
events { worker_connections 128; }
http {
  access_log off;
  include ${base}/upstream.conf;
  server {
    listen 127.0.0.1:${port};
    include ${base}/locations.conf;
    location /api/ { proxy_pass http://127.0.0.1:${primaryPort}; }
    location /nikowenku-archive/api/ { proxy_pass http://127.0.0.1:${primaryPort}/api/; }
  }
}
`);
  nginx = spawn('/usr/sbin/nginx', ['-p', base + '/', '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let nginxError = '';
  nginx.stderr.on('data', chunk => { nginxError += chunk; });
  nginx.on('error', error => { nginxError += error.message; });
  const origin = 'http://127.0.0.1:' + port;
  const get = async (path, options) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(25000) });
  let ready = false;
  for (let count = 0; count < 50; count++) {
    try { await get('/api/health'); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, nginxError);
  const health = async (readOnly, path = '/api/health') => {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).readOnly, readOnly);
  };
  const recover = async () => {
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      const response = await get('/api/health');
      if (response.ok && (await response.json()).readOnly === false) return;
      await delay(250);
    }
    assert.fail('primary did not recover within the fail_timeout probe window');
  };
  await health(false);
  await health(false, '/nikowenku-archive/api/health');
  const hits = primaryHits;
  assert.equal((await get('/api/books/book', { method: 'POST' })).status, 405);
  assert.equal(primaryHits, hits, 'write requests must not enter read upstream');
  mode = 404;
  assert.equal((await get('/api/library')).status, 404, '404 is not a failover condition');
  for (const status of [500, 502, 503, 504]) {
    mode = status;
    await health(true);
    mode = 200;
    await recover();
  }
  console.log('PASS primary preference, 404 passthrough, 500/502/503/504 failover and recovery');
  await close(primary);
  await health(true);
  await health(true, '/nikowenku-archive/api/health');
  for (const prefix of ['/api/', '/nikowenku-archive/api/']) {
    const catalog = await get(prefix + 'library?q=' + encodeURIComponent('故障切换'));
    assert.equal((await catalog.json()).total, 1);
    assert.equal((await (await get(prefix + 'books/book')).json()).title, '故障切换测试');
    const download = await get(prefix + 'books/book/files/text');
    assert.equal(download.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), createHash('sha256').update(text).digest('hex'));
    const head = await get(prefix + 'books/book/files/text', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), text.length);
  }
  await listen(primary, primaryPort);
  await recover();
  console.log('PASS connection-refused failover, both CLI prefixes, search/detail/download hashes/HEAD and automatic recovery');
  mode = 'timeout';
  await health(true);
  mode = 200;
  await recover();
  mode = 503;
  for (const prefix of ['/api/', '/nikowenku-archive/api/']) {
    assert.equal((await get(prefix + 'worker/status')).status, 503);
    assert.equal((await get(prefix + 'auth/session')).status, 503);
    assert.equal((await get(prefix + 'publish', { method: 'POST' })).status, 503);
  }
  console.log('PASS primary timeout fallback and management/login/publish remaining primary-only');
} finally {
  if (nginx && nginx.exitCode === null) { const stopped = new Promise(resolve => nginx.once('exit', resolve)); nginx.kill('SIGQUIT'); await stopped; }
  await close(primary);
  await close(backup);
  await rm(base, { recursive: true, force: true });
}
