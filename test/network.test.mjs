import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { resolveNetworkSettings, createNetwork } from '../server/network.mjs';

test('downloads follow an enabled Windows system proxy when environment proxy settings are absent', () => {
  const settings = resolveNetworkSettings({ env: {}, systemProxy: { enabled: true, server: '127.0.0.1:7897' } });
  assert.equal(settings.mode, 'system');
  assert.equal(settings.httpProxy, 'http://127.0.0.1:7897/');
  assert.equal(settings.httpsProxy, 'http://127.0.0.1:7897/');
  assert.match(settings.noProxy, /localhost/);
});

test('explicit and environment proxy choices take priority while local addresses and NO_PROXY remain respected', () => {
  const settings = resolveNetworkSettings({ env: { HTTPS_PROXY: 'http://127.0.0.1:9999', NO_PROXY: '.internal.example' }, systemProxy: { enabled: true, server: '127.0.0.1:7897' } });
  assert.equal(settings.mode, 'environment');
  assert.equal(settings.httpsProxy, 'http://127.0.0.1:9999/');
  assert.match(settings.noProxy, /internal\.example/);
  assert.match(settings.noProxy, /127\.0\.0\.1/);
  assert.equal(resolveNetworkSettings({ proxy: 'direct', env: { HTTPS_PROXY: 'http://127.0.0.1:9999' } }).mode, 'direct');
  assert.equal(resolveNetworkSettings({ env: { NO_PROXY: '*' } }).noProxy, '*');
  assert.equal(resolveNetworkSettings({ env: {}, systemProxy: { enabled: true, server: 'http=127.0.0.1:7897;https=127.0.0.1:7898' } }).httpsProxy, 'http://127.0.0.1:7898/');
  assert.throws(() => resolveNetworkSettings({ proxy: 'file:///private', env: {} }), /代理/);
});

test('the configured HTTP proxy is actually used to fetch a complete file without contacting external hosts', async t => {
  const connections = [];
  const sockets = new Set();
  const upstream = createServer((req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end('完整的本地代理测试正文。'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    connections.push(req.url);
    sockets.add(socket);
    const target = connect(upstream.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    sockets.add(target);
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const network = await createNetwork({ proxy: 'http://127.0.0.1:' + proxy.address().port, env: {} });
  t.after(async () => {
    await network.dispatcher.destroy();
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  const result = await fetch('http://books.example.test:' + upstream.address().port + '/full.txt', { dispatcher: network.dispatcher });
  assert.equal(await result.text(), '完整的本地代理测试正文。');
  assert.deepEqual(connections, ['books.example.test:' + upstream.address().port]);
});
