import type { Axes, Color, Overlay, Profile, Verdict } from './fourAxisMatch';
import profilesData from '../data/profiles.json';

// Minimal structural type for the D1 binding (real D1 satisfies this).
export type D1Stmt = {
  bind(...args: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { last_row_id: number; changes: number } }>;
};
export type D1 = { prepare(query: string): D1Stmt };

export type StoredProfile = { displayName: string; profile: Profile };
export type NewWine = {
  id: string;
  producer: string | null;
  name: string;
  vintage: number | null;
  region: string | null;
  country: string | null;
  grapes: string[] | null;
  abv: number | null;
  color: Color;
  acidity: number;
  sweetness: number;
  tannin: number;
  body: number;
  source: string;
  confidence: number | null;
};
export type StoredWine = NewWine & { scanCount: number };
export type Scan = { id: number; userId: string; wineId: string };

type ProfileRow = { user_id: string; display_name: string; base: string; overlays: string };
type WineRow = {
  id: string; producer: string | null; name: string; vintage: number | null;
  region: string | null; country: string | null; grapes: string | null; abv: number | null;
  color: Color; acidity: number; sweetness: number; tannin: number; body: number;
  source: string; confidence: number | null; scan_count: number;
};
type ScanRow = { id: number; user_id: string; wine_id: string };

const seeds = profilesData as unknown as Record<string, Profile>;
const displayName = (userId: string) => userId.charAt(0).toUpperCase() + userId.slice(1);

function toProfile(row: ProfileRow): StoredProfile {
  const overlays = JSON.parse(row.overlays) as { red: Overlay; white: Overlay; rose: Overlay };
  return { displayName: row.display_name, profile: { base: JSON.parse(row.base) as Axes, ...overlays } };
}

function toWine(row: WineRow): StoredWine {
  return {
    id: row.id,
    producer: row.producer,
    name: row.name,
    vintage: row.vintage,
    region: row.region,
    country: row.country,
    grapes: row.grapes ? (JSON.parse(row.grapes) as string[]) : null,
    abv: row.abv,
    color: row.color,
    acidity: row.acidity,
    sweetness: row.sweetness,
    tannin: row.tannin,
    body: row.body,
    source: row.source,
    confidence: row.confidence,
    scanCount: row.scan_count,
  };
}

export async function getProfile(db: D1, userId: string): Promise<StoredProfile | null> {
  const row = await db
    .prepare('SELECT user_id, display_name, base, overlays FROM profiles WHERE user_id = ?')
    .bind(userId)
    .first<ProfileRow>();
  return row ? toProfile(row) : null;
}

export async function saveProfile(db: D1, userId: string, display: string, profile: Profile): Promise<void> {
  const { base, ...overlays } = profile;
  await db
    .prepare(
      `INSERT INTO profiles (user_id, display_name, base, overlays, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, base = excluded.base,
         overlays = excluded.overlays, updated_at = datetime('now')`,
    )
    .bind(userId, display, JSON.stringify(base), JSON.stringify(overlays))
    .run();
}

export async function seedProfilesIfEmpty(db: D1): Promise<void> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM profiles').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return;
  for (const [userId, profile] of Object.entries(seeds)) {
    await saveProfile(db, userId, displayName(userId), profile);
  }
}

export async function getWine(db: D1, id: string): Promise<StoredWine | null> {
  const row = await db
    .prepare(
      `SELECT id, producer, name, vintage, region, country, grapes, abv, color,
         acidity, sweetness, tannin, body, source, confidence, scan_count
       FROM wines WHERE id = ?`,
    )
    .bind(id)
    .first<WineRow>();
  return row ? toWine(row) : null;
}

// First write wins: repeat scans only bump scan_count, so cached scores stay consistent.
export async function upsertWine(db: D1, w: NewWine): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wines (id, producer, name, vintage, region, country, grapes, abv, color,
         acidity, sweetness, tannin, body, source, confidence, scan_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET scan_count = wines.scan_count + 1, updated_at = datetime('now')`,
    )
    .bind(
      w.id, w.producer, w.name, w.vintage, w.region, w.country,
      w.grapes ? JSON.stringify(w.grapes) : null, w.abv, w.color,
      w.acidity, w.sweetness, w.tannin, w.body, w.source, w.confidence,
    )
    .run();
}

export async function insertScan(
  db: D1,
  s: { userId: string; wineId: string; score: number; buddies: string | null; cacheHit: number; readBy: string; latencyMs: number },
): Promise<number> {
  const r = await db
    .prepare('INSERT INTO scans (user_id, wine_id, score, buddies, cache_hit, read_by, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(s.userId, s.wineId, s.score, s.buddies, s.cacheHit, s.readBy, s.latencyMs)
    .run();
  return r.meta.last_row_id;
}

export async function getScan(db: D1, id: number): Promise<Scan | null> {
  const row = await db.prepare('SELECT id, user_id, wine_id FROM scans WHERE id = ?').bind(id).first<ScanRow>();
  return row ? { id: row.id, userId: row.user_id, wineId: row.wine_id } : null;
}

export async function setScanFeedback(db: D1, id: number, verdict: Verdict): Promise<void> {
  await db.prepare('UPDATE scans SET feedback = ? WHERE id = ?').bind(verdict, id).run();
}

export async function scanStats(db: D1, day: string): Promise<{ scans: number; cacheHits: number }> {
  const row = await db
    .prepare('SELECT COUNT(*) AS scans, COALESCE(SUM(cache_hit), 0) AS hits FROM scans WHERE date(created_at) = ?')
    .bind(day)
    .first<{ scans: number; hits: number }>();
  return { scans: row?.scans ?? 0, cacheHits: row?.hits ?? 0 };
}

export async function resetDemo(db: D1): Promise<void> {
  await db.prepare('DELETE FROM scans').run();
  for (const [userId, profile] of Object.entries(seeds)) {
    await saveProfile(db, userId, displayName(userId), profile);
  }
}
