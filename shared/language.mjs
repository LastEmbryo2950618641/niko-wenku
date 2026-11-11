export function languageRank(value) {
  const language = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  if (/简体|簡體/.test(language)) return 0;
  if (/繁体|繁體/.test(language)) return 1;
  const parts = language.split('-');
  if (parts[0] !== 'zh') return 2;
  if (parts.includes('hans')) return 0;
  if (parts.includes('hant')) return 1;
  if (parts.includes('cn') || parts.includes('sg')) return 0;
  if (parts.some(part => ['tw', 'hk', 'mo'].includes(part))) return 1;
  return 2;
}

export function languageLabel(value) {
  const rank = languageRank(value);
  if (rank === 0) return '简体中文';
  if (rank === 1) return '繁体中文';
  const language = String(value || '').trim();
  if (!language) return '语言未标注';
  if (/^zh(?:-|_|$)/i.test(language)) return '中文（简繁未标注）';
  return ({ en: '英语', ja: '日语', ko: '韩语' })[language.toLowerCase()] || language;
}
