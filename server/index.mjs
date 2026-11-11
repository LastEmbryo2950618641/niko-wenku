import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAppServer } from './app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { dev: { type: 'boolean', default: false }, port: { type: 'string' }, library: { type: 'string' }, queue: { type: 'string' }, 'state-dir': { type: 'string' }, 'auth-file': { type: 'string' }, 'public-origin': { type: 'string' } } });
const port = Number(values.port || process.env.ARCHIVE_PORT || 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
const libraryRoot = resolve(values.library || process.env.ARCHIVE_LIBRARY || join(root, 'library'));
const authFile = values['auth-file'] || process.env.ARCHIVE_AUTH_FILE;
const server = await createAppServer({ libraryRoot, webRoot: join(root, 'dist'), dev: values.dev, adminAuthFile: authFile ? resolve(authFile) : undefined, publicOrigin: values['public-origin'] || process.env.ARCHIVE_PUBLIC_ORIGIN, worker: { queuePath: resolve(values.queue || process.env.ARCHIVE_QUEUE || join(root, 'download-queue.json')), stateDir: resolve(values['state-dir'] || process.env.ARCHIVE_STATE_DIR || join(root, '.state')) } });
server.listen(port, '127.0.0.1', () => {
  console.log('\n文库档案已启动：http://127.0.0.1:' + port);
  console.log('书库目录：' + libraryRoot);
  console.log('放入 JSON + 完整 TXT 后会自动上架，无须重新构建。\n');
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已占用，请使用 --port 指定其他端口。' : error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
