import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
const blocked = /^(?:library|secrets|\.state|node_modules|dist|\.playwright-cli|\.playwright-mcp|output)\/|^download-queue\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem|pfx|p12|tar|zip)(?:\.gz)?$/i;
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bcf_clearance=[A-Za-z0-9_.-]{30,}/,
  /\bPHPSESSID=[A-Za-z0-9-]{16,}/,
  /\bjieqiUserPassword(?:%3D|=)[a-f0-9]{32}/i
];
const issues = [];
for (const path of files) {
  if (path !== '.env.example' && blocked.test(path)) { issues.push(path + ': 不应公开的运行数据或凭据文件'); continue; }
  if ((await stat(path)).size > 5 * 1024 * 1024) { issues.push(path + ': 超出源码文件大小上限，请将运行数据移出 Git'); continue; }
  const text = await readFile(path, 'utf8');
  if (secrets.some(pattern => pattern.test(text))) issues.push(path + ': 检测到疑似真实密钥或登录 Cookie');
}
if (!files.length) issues.push('没有找到 Git 跟踪文件，无法完成公开内容检查');
if (issues.length) { for (const issue of issues) console.error(issue); process.exitCode = 1; }
else console.log('公开内容检查通过：' + files.length + ' 个文件；未跟踪运行书库、账号凭据或 Cookie。');
