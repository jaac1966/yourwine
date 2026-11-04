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

// Canonical wine name: producer + distinctive name, trailing vintage removed.
// Removes every leading repeat of the producer, re-adds it once, then strips
// a trailing 4-digit year equal to vintage (or any plausible 1950-2035 year
// when vintage is null). Idempotent: safe to apply to stored names.
export function canonicalName(producer: string, name: string, vintage?: number | null): string {
  let n = name.replace(/\s+/g, ' ').trim();
  const prod = producer.replace(/\s+/g, ' ').trim();
  if (prod) {
    const p = slug(prod);
    while (p && slug(n).startsWith(p + '-') && n.toLowerCase().startsWith(prod.toLowerCase())) {
      n = n.slice(prod.length).replace(/^[\s\-–—:]+/, '').trim();
    }
    n = `${prod} ${n}`.trim();
  }
  const yearMatch = n.match(/\s+(\d{4})$/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    const v = vintage != null ? Number(vintage) : null;
    if ((v != null && year === v) || (v == null && year >= 1950 && year <= 2035)) {
      n = n.slice(0, -yearMatch[0].length);
    }
  }
  return n.replace(/\s+/g, ' ').trim();
}
