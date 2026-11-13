#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const output = fileURLToPath(new URL('../public/', import.meta.url));
const tools = new URL('../tools/niko-cli/', import.meta.url);
await mkdir(output, { recursive: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/pack.mjs', tools)), '--output', output], {
  stdio: 'inherit', env: process.env, windowsHide: true
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
await copyFile(new URL('packages/nikowenku-archive/skill/SKILL.md', tools), new URL('../public/nikowenku-archive-skill.md', import.meta.url));
