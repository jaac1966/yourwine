// Stable wine ids: slug(producer)-slug(name)-(vintage or "nv").
// Keep in sync with scripts/seed_sql.mjs (plain JS copy for node).
export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function wineId(producer: string, name: string, vintage?: number | null): string {
  const p = slug(producer);
  let n = slug(name);
  if (p && n.startsWith(p + '-')) n = n.slice(p.length + 1);
  return `${p}-${n}-${vintage ?? 'nv'}`;
}
