// Exercises the full learning loop against a running Worker:
// reset → scan (miss) → feedback loved → scan again (hit) → usage.
// Usage: node scripts/demo_learn.mjs [--api URL] [--user NAME] --photo <path>
import { readFile } from 'node:fs/promises';

// Keep in sync with api/src/wineId.ts (the /scan response carries no id).
const slug = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
const wineId = (producer, name, vintage) => {
  const p = slug(producer);
  let n = slug(name);
  if (p && n.startsWith(p + '-')) n = n.slice(p.length + 1);
  return `${p}-${n}-${vintage ?? 'nv'}`;
};

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  if (args[i].includes('=')) return args[i].slice(name.length + 3);
  return args[i + 1] ?? def;
};

const api = opt('api', 'http://127.0.0.1:8787');
const user = opt('user', 'alex');
const photo = opt('photo', null);
if (!photo) {
  console.error('Usage: node scripts/demo_learn.mjs [--api URL] [--user NAME] --photo <path to a jpg>');
  process.exit(2);
}

async function call(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(api + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { data: text ? JSON.parse(text) : {}, ms };
}

const photoBuf = await readFile(photo);
const photoB64 = photoBuf.toString('base64');
const mime = photo.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

// Step 1: reset.
const reset = await call('POST', '/reset');
console.log(`1. POST /reset → ${JSON.stringify(reset.data)}`);

// Step 2: scan (same JSON shape the Android app sends).
async function scan() {
  const { data, ms } = await call('POST', '/scan', { photo_b64: photoB64, mime, user, buddies: '' });
  const match = data.matches.find((m) => m.user === user) ?? data.matches[0];
  const id = wineId(data.wine.producer ?? '', data.wine.name, data.wine.vintage ?? null);
  return {
    id, name: data.wine.name, color: data.wine.color, score: match.score,
    scanId: data.scan_id, cacheHit: data.cache_hit, readBy: data.read_by ?? data.readBy, ms,
  };
}
const show = (s) =>
  `wine ${s.id} (${s.name}), score ${s.score}, scan_id ${s.scanId}, cache_hit ${s.cacheHit}, read_by ${s.readBy}, latency_ms ${s.ms} (round-trip)`;
const first = await scan();
console.log(`2. POST /scan → ${show(first)}`);

// Step 3: loved.
const fb = await call('POST', '/feedback', { scan_id: first.scanId, verdict: 'loved' });
const overlayKey = first.color === 'sparkling' ? 'white' : first.color;
const overlay = fb.data[overlayKey];
console.log(`3. POST /feedback loved → ${overlayKey} overlay ${JSON.stringify(overlay.axes)} n=${overlay.n}`);

// Step 4: scan again.
const second = await scan();
const delta = second.score - first.score;
console.log(`4. POST /scan → ${show(second)}, score delta ${delta >= 0 ? '+' : ''}${delta}`);

// Step 5: usage.
const usage = await call('GET', '/usage');
console.log(`5. GET /usage → ${JSON.stringify(usage.data)}`);

console.log(`miss: ${first.ms} ms (${first.readBy}) → hit: ${second.ms} ms, score ${first.score} → ${second.score}`);
if (second.cacheHit !== 1) {
  console.error('FAIL: step 4 was not a cache hit');
  process.exit(1);
}
if (delta === 0) {
  console.error('FAIL: score did not move after loved feedback');
  process.exit(1);
}
