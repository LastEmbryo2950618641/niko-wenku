export function readingParagraphs(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
  const lengths = new Map();
  let nonEmpty = 0;
  for (const line of lines) {
    if (!line) continue;
    nonEmpty++;
    if (line.length >= 20 && line.length <= 100) lengths.set(line.length, (lengths.get(line.length) || 0) + 1);
  }
  const common = Math.max(0, ...lengths.values());
  const hardWrapped = common >= 6 && common >= nonEmpty * 0.3;
  if (!hardWrapped) return lines.filter(Boolean);
  return lines.join('\n').split(/\n{2,}/).filter(Boolean).map(block => {
    const parts = block.split('\n');
    const long = parts.filter(line => line.length >= 20).length;
    if (long < parts.length * 0.4) return block;
    return parts.reduce((result, part) => result + (/[a-zA-Z0-9]$/.test(result) && /^[a-zA-Z0-9]/.test(part) ? ' ' : '') + part, '');
  });
}
