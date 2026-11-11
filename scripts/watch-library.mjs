import { mkdir, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runDownloadWorker } from '../server/download-worker.mjs';
import { readJsonFile, writeJsonAtomic, loadDownloadQueue } from '../server/download-queue.mjs';
import { languageLabel } from '../shared/language.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const project = resolve(dirname(scriptPath), '..');
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function optionalJson(path) {
  try { return await readJsonFile(path, 16 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    queue: { type: 'string' }, library: { type: 'string' }, 'state-dir': { type: 'string' },
    once: { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    background: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (positionals.length) throw new Error('队列路径请使用 --queue 指定');
  if ([values.once, values.status, values.stop, values.background].filter(Boolean).length > 1) throw new Error('--once、--status、--stop 和 --background 不能同时使用');
  const queuePath = resolve(values.queue || join(project, 'download-queue.json'));
  const libraryRoot = resolve(values.library || process.env.ARCHIVE_LIBRARY || join(project, 'library'));
  const stateDir = resolve(values['state-dir'] || join(project, '.state'));
  const lockPath = join(stateDir, 'worker.lock');
  const statePath = join(stateDir, 'worker-state.json');
  if (values.help) {
    console.log('用法：node scripts/watch-library.mjs [--queue 书单.json] [--library 书库目录] [--state-dir 状态目录]');
    console.log('默认前台持续执行；--background 后台启动；--once 执行一轮；--status 查看 JSON 状态；--stop 安全停止。');
  } else if (values.status) {
    const [state, lock] = await Promise.all([optionalJson(statePath), optionalJson(lockPath)]);
    const running = Boolean(lock && alive(lock.pid));
    console.log(JSON.stringify({ ...(state || { status: 'not_started', books: {}, queuePath, libraryRoot }), running, pid: running ? lock.pid : state?.pid ?? null }, null, 2));
  } else if (values.stop) {
    const lock = await optionalJson(lockPath);
    if (!lock || !alive(lock.pid)) console.log('下载脚本当前未运行。');
    else {
      await writeJsonAtomic(join(stateDir, 'worker.stop'), { token: lock.token, requestedAt: new Date().toISOString() });
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        await delay(100);
        const current = await optionalJson(lockPath);
        if (!current || current.token !== lock.token || !alive(lock.pid)) { stopped = true; break; }
      }
      console.log(stopped ? '下载脚本已安全停止。' : '已发送停止请求，正在结束当前文件操作；可用 download:status 查看。');
    }
  } else if (values.background) {
    await loadDownloadQueue(queuePath);
    const current = await optionalJson(lockPath);
    if (current && alive(current.pid)) throw new Error('下载脚本已在运行，不启动第二个实例');
    await mkdir(stateDir, { recursive: true });
    const stdout = await open(join(stateDir, 'worker.stdout.log'), 'a');
    const stderr = await open(join(stateDir, 'worker.stderr.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, '--queue', queuePath, '--library', libraryRoot, '--state-dir', stateDir], {
        cwd: project, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd]
      });
      await new Promise((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject); });
      child.unref();
    } finally { await Promise.all([stdout.close(), stderr.close()]); }
    let started = false;
    for (let i = 0; i < 60; i++) {
      await delay(100);
      const [lock, state] = await Promise.all([optionalJson(lockPath), optionalJson(statePath)]);
      if (lock?.pid === child.pid && state?.pid === child.pid && state.running) { started = true; break; }
      if (!alive(child.pid)) break;
    }
    if (!started) throw new Error('后台启动未确认，请查看状态目录中的 worker.stderr.log');
    console.log('后台下载脚本已启动，PID：' + child.pid);
    console.log('书单：' + queuePath);
    console.log('日志：' + join(stateDir, 'worker.stdout.log'));
  } else {
    let lastStatus;
    await runDownloadWorker({ queuePath, libraryRoot, stateDir, once: values.once, signal: controller.signal, onEvent(event) {
      if (['idle', 'paused', 'auth_required', 'config_error', 'cooldown'].includes(event.event)) {
        if (lastStatus === event.event && !event.id) return;
        lastStatus = event.event;
      } else lastStatus = event.event;
      const label = {
        started: '队列已启动', downloading: '正在下载', published: '已自动上架', idle: '等待书单中的新任务',
        paused: '书单已暂停', auth_required: '登录态失效，等待 Cookie 更新', config_error: '书单格式错误，等待修正',
        retry_wait: '临时失败，已安排重试', failed: '任务失败，等待修改或重试标记', resumed: '队列已恢复',
        discovering: '正在读取编号书目资料', discovered: '已按编号保存书目资料', missing: '编号或全本文件不存在，已跳过', cooldown: '站点要求限速，整个队列等待恢复',
        cover_saved: '已保存本地封面', cover_skipped: '封面暂不可用，正文已上架',
        checking_catalog: '自动检查最新书籍编号', catalog_checked: '已检查新编号并更新扫描范围', catalog_retry: '新编号检查暂未成功，已安排自动重试'
      }[event.event] || event.event;
      console.log('[' + event.at + '] ' + label + (event.id ? '：' + event.id : '') +
        (event.language ? '（' + languageLabel(event.language) + '，' + event.bytes + ' bytes）' : '') +
        (event.nextAttemptAt ? '，下次：' + event.nextAttemptAt : ''));
    } });
    console.log('下载脚本已退出。');
  }
} catch (error) {
  console.error(error.message || '下载脚本未能完成，请检查本地配置');
  process.exitCode = 1;
}
