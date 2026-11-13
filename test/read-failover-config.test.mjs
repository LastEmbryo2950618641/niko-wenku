import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const original = `# unrelated origin map stays intact
server {
    listen 443 ssl;
    ssl_certificate /private/site/fullchain.pem;
    location /chat-api/ { proxy_pass http://127.0.0.1:4181; }
    location = /nikowenku-archive {
        return 308 /nikowenku-archive/;
    }
    location /api/ { proxy_pass http://127.0.0.1:4178; }
    location /worldseed/ { proxy_pass http://127.0.0.1:8791; }
}
`;

test('gateway install preserves existing TLS, management and other apps and can be repeated', async t => {
  const { configureReadFailover } = await import('../deploy/configure-read-failover.mjs');
  const base = await mkdtemp(join(tmpdir(), 'wenku-gateway-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sitePath = join(base, 'site');
  await writeFile(sitePath, original);
  const settings = { sitePath, nginxRoot: base, validate: async () => {}, reload: async () => {} };
  await configureReadFailover(settings);
  const first = await readFile(sitePath, 'utf8');
  // Removing just the managed block must reproduce the entire original site.
  assert.equal(first.replace(/    # BEGIN wenku read failover[\s\S]*?    # END wenku read failover\n\n/, ''), original);
  await configureReadFailover(settings);
  assert.equal(await readFile(sitePath, 'utf8'), first);
  assert.ok((await readdir(join(base, 'conf.d'))).some(name => name.endsWith('.conf')));
});

test('failed nginx validation rolls back every changed config', async t => {
  const { configureReadFailover } = await import('../deploy/configure-read-failover.mjs');
  const base = await mkdtemp(join(tmpdir(), 'wenku-gateway-rollback-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sitePath = join(base, 'site');
  await writeFile(sitePath, original);
  await mkdir(join(base, 'conf.d'));
  const upstream = join(base, 'conf.d/niko-wenku-read-upstream.conf');
  await writeFile(upstream, '# prior upstream\n');
  await assert.rejects(configureReadFailover({ sitePath, nginxRoot: base, validate: async () => { throw new Error('invalid nginx configuration'); }, reload: async () => { throw new Error('must not reload'); } }), /invalid nginx configuration/);
  assert.equal(await readFile(sitePath, 'utf8'), original);
  assert.equal(await readFile(upstream, 'utf8'), '# prior upstream\n');
  assert.deepEqual((await readdir(join(base, 'snippets'))).filter(name => name.endsWith('.conf')), []);
});

test('unrecognized or ambiguous site layout is rejected without changing configuration', async t => {
  const { configureReadFailover } = await import('../deploy/configure-read-failover.mjs');
  const base = await mkdtemp(join(tmpdir(), 'wenku-gateway-unknown-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sitePath = join(base, 'site');
  for (const text of ['server { location / { } }', original + original]) {
    await writeFile(sitePath, text);
    await assert.rejects(configureReadFailover({ sitePath, nginxRoot: base, validate: async () => {}, reload: async () => {} }), /唯一/);
    assert.equal(await readFile(sitePath, 'utf8'), text);
  }
});
