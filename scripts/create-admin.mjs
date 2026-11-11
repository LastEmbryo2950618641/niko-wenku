import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createAdminCredentials } from '../server/admin-auth.mjs';

try {
  const { values } = parseArgs({ options: { file: { type: 'string' }, username: { type: 'string' }, generate: { type: 'boolean' }, stdin: { type: 'boolean' }, force: { type: 'boolean' }, 'save-login': { type: 'string' } } });
  if (values.generate && values.stdin) throw new Error('--generate 和 --stdin 不能同时使用');
  const path = resolve(values.file || 'secrets/admin-auth.json');
  let username = values.username, password;
  if (values.stdin) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error('登录配置输入过大'); }
    const supplied = JSON.parse(input);
    username ??= supplied.username;
    password = supplied.password;
  } else if (values.generate) {
    if (!username) throw new Error('生成密码时请使用 --username 指定账号');
    password = randomBytes(18).toString('base64url');
  } else {
    if (!process.stdin.isTTY) throw new Error('请在交互终端执行，或使用 --stdin 通过标准输入提供 JSON；不要把密码放入命令参数');
    let muted = false;
    const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      username ??= (await prompt.question('管理账号：')).trim();
      process.stdout.write('管理密码（输入不回显）：'); muted = true;
      password = await prompt.question('');
      muted = false; process.stdout.write('\n');
    } finally { prompt.close(); }
  }
  const credentials = await createAdminCredentials(username, password);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(credentials, null, 2) + '\n', { flag: values.force ? 'w' : 'wx', mode: 0o600 });
  console.log('管理账号已创建：' + username);
  console.log('密码哈希配置：' + path);
  if (values.generate || values['save-login']) {
    const loginPath = resolve(values['save-login'] || join(dirname(path), 'admin-login.json'));
    if (loginPath === path) throw new Error('登录信息与哈希配置不能使用同一个文件');
    await mkdir(dirname(loginPath), { recursive: true, mode: 0o700 });
    await writeFile(loginPath, JSON.stringify({ username, password }, null, 2) + '\n', { flag: values.force ? 'w' : 'wx', mode: 0o600 });
    console.log('登录信息已保存至私有文件：' + loginPath + '（请勿公开）');
  }
  console.log('设置 ARCHIVE_AUTH_FILE 指向此配置并重启服务后生效。');
} catch (error) { console.error(error.code === 'EEXIST' ? '账号文件已存在；如需重置，请明确添加 --force 并重启服务。' : error.message); process.exitCode = 1; }
