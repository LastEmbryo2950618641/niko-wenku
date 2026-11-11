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
  for (const directory of ['scripts', 'server', 'shared', 'skill']) await mkdir(join(packageDir, directory));
  for (const [source, destination] of [
    ['scripts/cli.mjs', 'scripts/cli.mjs'],
    ['server/library.mjs', 'server/library.mjs'],
    ['server/text.mjs', 'server/text.mjs'],
    ['shared/language.mjs', 'shared/language.mjs'],
    ['.agents/skills/nikowenku-archive/SKILL.md', 'skill/SKILL.md'],
    ['LICENSE', 'LICENSE']
  ]) await copyFile(join(root, source), join(packageDir, destination));

  const manifest = {
    name: 'nikowenku-archive',
    version: rootManifest.version,
    description: 'Search, inspect, and download light novels from Wenku Archive',
    type: 'module',
    bin: { 'nikowenku-archive': './scripts/cli.mjs' },
    engines: { node: '>=22' },
    files: ['scripts/cli.mjs', 'server/library.mjs', 'server/text.mjs', 'shared/language.mjs', 'skill/SKILL.md', 'LICENSE', 'README.md']
  };
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const readme = [
    '# nikowenku-archive',
    '',
    'A cross-platform CLI for the Wenku Archive, whose collection focuses mainly on light novels and may include other works.',
    '',
    'Requires Node.js 22 or newer. Install from npm with `npm install -g nikowenku-archive`, or install offline from `npm install -g --offline ./nikowenku-archive-' + rootManifest.version + '.tgz`.',
    '',
    'The CLI connects to the public Wenku Archive site by default. Set `ARCHIVE_SITE_URL` or pass `--site <url>` to use another server.',
    '',
    'For a local library, pass `--local` or `--library <path>`. Without a path it uses `./library` relative to the current working directory.',
    '',
    'The Codex Skill command manual is included at `skill/SKILL.md`. Copy it to `.agents/skills/nikowenku-archive/SKILL.md` in a project to enable the Skill there.',
    '',
    "On Windows PowerShell, use `Copy-Item (Join-Path (npm root -g) 'nikowenku-archive\\skill\\SKILL.md') .agents\\skills\\nikowenku-archive\\SKILL.md` after creating the destination directory. On Linux or macOS, use `cp \"$(npm root -g)/nikowenku-archive/skill/SKILL.md\" .agents/skills/nikowenku-archive/SKILL.md` after `mkdir -p .agents/skills/nikowenku-archive`.",
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
  await copyFile(join(root, '.agents', 'skills', 'nikowenku-archive', 'SKILL.md'), join(output, 'nikowenku-archive-skill.md'));
  console.log(`Created ${join(output, `nikowenku-archive-${rootManifest.version}.tgz`)}`);
  console.log(`Created ${join(output, 'nikowenku-archive-skill.md')}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
