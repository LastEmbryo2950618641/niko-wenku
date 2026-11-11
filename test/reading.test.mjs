import test from 'node:test';
import assert from 'node:assert/strict';
import { readingParagraphs } from '../src/reading-text.js';
test('hard-wrapped book lines reflow without modifying poetic line breaks', () => {
  const line = '古典小说的正文在源文件中以固定宽度换行';
  const content = '诗曰：\n    混沌未分天地乱\n    茫茫渺渺无人见\n\n' + Array.from({ length: 12 }, () => line + '，继续阅读').join('\n');
  const paragraphs = readingParagraphs(content);
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[0], /诗曰：\n混沌/);
  assert.equal(paragraphs[1].includes('\n'), false);
});
test('normal TXT paragraphs retain their boundaries', () => {
  assert.deepEqual(readingParagraphs('第一段正文。\n第二段正文。\n\n第三段正文。'), ['第一段正文。', '第二段正文。', '第三段正文。']);
});
