import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createAppServer } from './app.mjs';

// Deliberately does not read ARCHIVE_QUEUE, ARCHIVE_AUTH_FILE or the main state/port.
const { values } = parseArgs({ options: {
  port: { type: 'string' }, library: { type: 'string' },
  'state-dir': { type: 'string' }, 'public-origin': { type: 'string' }
} });
const library = values.library || process.env.ARCHIVE_LIBRARY;
const state = values['state-dir'] || process.env.ARCHIVE_READ_STATE_DIR;
if (!library) throw new Error('请显式配置 ARCHIVE_LIBRARY 或 --library，备用服务不会创建书库');
if (!state) throw new Error('请显式配置 ARCHIVE_READ_STATE_DIR 或 --state-dir，不能共用主服务状态目录');
const port = Number(values.port || process.env.ARCHIVE_READ_PORT || 4179);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
const server = await createAppServer({
  libraryRoot: resolve(library), stateDir: resolve(state), readOnly: true,
  publicOrigin: values['public-origin'] || process.env.ARCHIVE_PUBLIC_ORIGIN
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('文库只读备用 API：http://127.0.0.1:' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit());
  setTimeout(() => { server.closeAllConnections(); }, 10000).unref();
});
