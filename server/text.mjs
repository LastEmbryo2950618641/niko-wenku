const chapterPattern = /^[ \t\u3000]*(第[零〇○一二三四五六七八九十百千万两\d０-９]{1,12}[章回节話话卷部册集篇][^\r\n]{0,65}|(?:序章|楔子|序幕|后记|後記|终章|終章|尾声|尾聲|番外)(?:[ \t\u3000：:·][^\r\n]{0,60})?|(?:chapter|volume)[ \t]+\d+[^\r\n]{0,60})[ \t\u3000]*$/gim;
export function countWords(text) {
  return (text.match(/[\p{L}\p{N}]/gu) || []).length;
}
export function decodeBook(buffer, requested = 'auto') {
  let encoding = String(requested || 'auto').toLowerCase();
  if (encoding === 'auto') {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
    else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
    else {
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''), encoding: 'utf-8' };
      } catch {
        encoding = 'gb18030';
      }
    }
  }
  const text = new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  return { text: text.replace(/\r\n?/g, '\n'), encoding };
}
export function indexBook(input) {
  const text = input.replace(/\r\n?/g, '\n');
  const matches = [...text.matchAll(chapterPattern)];
  const isVolume = title => /^(第.+[卷部册集]|volume[ \t]+\d+)/i.test(title);
  const hasChapters = matches.some(match => !isVolume(match[1].trim()));
  let volume = '';
  const headings = [];
  for (const match of matches) {
    const title = match[1].trim();
    if (title.endsWith('。')) continue;
    if (hasChapters && isVolume(title)) { volume = title; continue; }
    headings.push({ title, volume, start: match.index, bodyStart: match.index + match[0].length });
  }
  const chapters = headings.length ? headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? text.length;
    const body = text.slice(heading.bodyStart, end).trim();
    return { index, title: heading.title, volume: heading.volume, start: heading.bodyStart, end, wordCount: countWords(body) };
  }) : [{ index: 0, title: '全文', volume: '', start: 0, end: text.length, wordCount: countWords(text) }];
  return { text, chapters, wordCount: countWords(text) };
}
