import { mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'no-demo': { type: 'boolean' } } });
const data = resolve(values['data-dir'] || project);
for (const folder of ['library', '.state', 'secrets']) await mkdir(join(data, folder), { recursive: true, mode: 0o700 });
async function copyMissing(source, target) {
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await copyMissing(join(project, 'download-queue.example.json'), join(data, 'download-queue.json'));
if (!values['no-demo']) {
  const demo = join(data, 'library', 'original-demo');
  await mkdir(demo, { recursive: true });
  await copyMissing(join(project, 'examples', 'original-demo', 'content.txt'), join(demo, 'content.txt'));
  await copyMissing(join(project, 'examples', 'original-demo', 'book.json'), join(demo, 'book.json'));
}
console.log('实例目录已准备：' + data);
console.log('已有队列、书库与断点均保留。示例队列默认暂停，不主动请求外部站点。');
