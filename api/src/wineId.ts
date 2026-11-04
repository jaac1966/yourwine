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

// Stable display name: producer + distinctive name, trailing vintage removed.
// Removes every leading repeat of the producer, re-adds it once, then strips
// a trailing year equal to vintage. Idempotent.
export function displayName(producer: string, name: string, vintage?: number | null): string {
  let n = name.replace(/\s+/g, ' ').trim();
  const prod = producer.replace(/\s+/g, ' ').trim();
  if (prod) {
    const p = slug(prod);
    while (p && slug(n).startsWith(p + '-') && n.toLowerCase().startsWith(prod.toLowerCase())) {
      n = n.slice(prod.length).replace(/^[\s\-–—:]+/, '').trim();
    }
    n = `${prod} ${n}`.trim();
  }
  if (vintage != null) {
    n = n.replace(new RegExp(`\\s+${vintage}$`), '');
  }
  return n.replace(/\s+/g, ' ').trim();
}
