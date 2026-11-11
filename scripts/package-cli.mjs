#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public');
const scratch = await mkdtemp(join(tmpdir(), 'nikowenku-cli-'));
const packageDir = join(scratch, 'package');
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

try {
  await mkdir(packageDir, { recursive: true });
  for (const directory of ['scripts', 'server', 'shared']) await mkdir(join(packageDir, directory));
  for (const [source, destination] of [
    ['scripts/cli.mjs', 'scripts/cli.mjs'],
    ['server/library.mjs', 'server/library.mjs'],
    ['server/text.mjs', 'server/text.mjs'],
    ['shared/language.mjs', 'shared/language.mjs'],
    ['LICENSE', 'LICENSE']
  ]) await copyFile(join(root, source), join(packageDir, destination));

  const manifest = {
    name: 'nikowenku-archive',
    version: rootManifest.version,
    description: 'Search, inspect, and download books from Wenku Archive',
    type: 'module',
    bin: { 'nikowenku-archive': './scripts/cli.mjs' },
    engines: { node: '>=22' },
    files: ['scripts/cli.mjs', 'server/library.mjs', 'server/text.mjs', 'shared/language.mjs', 'LICENSE', 'README.md']
  };
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const readme = [
    '# nikowenku-archive',
    '',
    'Requires Node.js 22 or newer. Install offline with `npm install -g --offline ./nikowenku-archive-' + rootManifest.version + '.tgz`.',
    '',
    'The CLI connects to the public Wenku Archive site by default. Set `ARCHIVE_SITE_URL` or pass `--site <url>` to use another server.',
    '',
    'For a local library, pass `--local` or `--library <path>`. Without a path it uses `./library` relative to the current working directory.',
    '',
    'Run `nikowenku-archive --help` to see all commands.',
    ''
  ].join('\n');
  await writeFile(join(packageDir, 'README.md'), readme);

  const npmArgs = ['pack', packageDir, '--pack-destination', output];
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: root, encoding: 'utf8', stdio: 'inherit' })
    : spawnSync('npm', npmArgs, { cwd: root, encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited with ${result.status}`);
  console.log(`Created ${join(output, `nikowenku-archive-${rootManifest.version}.tgz`)}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
