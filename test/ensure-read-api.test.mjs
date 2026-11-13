import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t, initial = 'healthy') {
  const base = await mkdtemp(join(tmpdir(), 'wenku-ensure-'));
  let mode = initial;
  const server = createServer((req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'unavailable') { res.writeHead(503); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, readOnly: mode !== 'primary' }));
    if (mode === 'broken-library') { res.writeHead(500); return res.end('{}'); }
    res.end(JSON.stringify({ books: [], total: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { base, baseUrl: 'http://127.0.0.1:' + server.address().port, setMode: value => { mode = value; } };
}

test('healthy read-only service is left untouched during deployment', async t => {
  const { ensureReadApi } = await import('../deploy/ensure-read-api.mjs');
  const { base, baseUrl } = await fixture(t);
  const release = join(base, 'installed-version');
  await writeFile(release, 'keep this version');
  const before = await readFile(release);
  const result = await ensureReadApi({ baseUrl, install: () => writeFile(release, 'reinstalled') });
  assert.equal(result.action, 'skipped');
  assert.deepEqual(await readFile(release), before);
});

for (const mode of ['unavailable', 'primary', 'broken-library', 'timeout']) {
  test('deployment reinstalls an unusable standby: ' + mode, async t => {
    const { ensureReadApi } = await import('../deploy/ensure-read-api.mjs');
    const { base, baseUrl, setMode } = await fixture(t, mode);
    const result = await ensureReadApi({ baseUrl, timeoutMs: 100, install: async () => {
      await writeFile(join(base, 'installed-version'), 'repaired read-only service');
      setMode('healthy');
    } });
    assert.equal(result.action, 'repaired');
    assert.equal(await readFile(join(base, 'installed-version'), 'utf8'), 'repaired read-only service');
  });
}

test('repair failure aborts deployment instead of reporting success', async t => {
  const { ensureReadApi } = await import('../deploy/ensure-read-api.mjs');
  const { baseUrl } = await fixture(t, 'unavailable');
  await assert.rejects(ensureReadApi({ baseUrl, install: async () => { throw new Error('installer failed'); } }), /installer failed/);
  await assert.rejects(ensureReadApi({ baseUrl, install: async () => {} }), /备用.*仍不可用/);
});
