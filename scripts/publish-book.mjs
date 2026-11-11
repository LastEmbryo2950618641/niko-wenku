import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publishBundle } from '../server/library.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { manifest: { type: 'string' }, text: { type: 'string' }, cover: { type: 'string' }, library: { type: 'string' } } });
  const manifestPath = resolve(values.manifest || positionals[0] || '');
  if (!values.manifest && !positionals[0]) throw new Error('用法：npm run publish:book -- --manifest metadata.json --text full.txt [--cover cover.jpg]');
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const buffers = {};
  if (values.text) {
    manifest.files = { ...manifest.files, text: basename(values.text) };
    buffers[manifest.files.text] = await readFile(resolve(values.text));
  }
  if (values.cover) {
    manifest.files = { ...manifest.files, cover: basename(values.cover) };
    buffers[manifest.files.cover] = await readFile(resolve(values.cover));
  }
  for (const name of Object.values(manifest.files || {})) if (!buffers[name]) buffers[name] = await readFile(resolve(dirname(manifestPath), name));
  const root = resolve(values.library || join(dirname(fileURLToPath(import.meta.url)), '..', 'library'));
  console.log(JSON.stringify(await publishBundle(root, manifest, buffers), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
