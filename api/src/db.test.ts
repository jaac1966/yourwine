import { describe, expect, it } from 'vitest';
import {
  getProfile, getScan, getWine, insertScan, resetDemo, saveProfile, scanStats,
  seedProfilesIfEmpty, setScanFeedback, upsertWine,
} from './db';
import { createFakeDb } from './fakeDb';

const testWine = {
  id: 'la-cetto-cabernet-sauvignon-2020',
  producer: 'L.A. Cetto',
  name: 'Cabernet Sauvignon',
  vintage: 2020,
  region: 'Valle de Guadalupe',
  country: 'Mexico',
  grapes: ['Cabernet Sauvignon'],
  abv: 13,
  color: 'red' as const,
  acidity: 3,
  sweetness: 2,
  tannin: 3,
  body: 3,
  source: 'spark',
  confidence: 0.9,
};

describe('profiles', () => {
  it('seeds from profiles.json once and never overwrites', async () => {
    const db = createFakeDb();
    await seedProfilesIfEmpty(db);
    const alex = await getProfile(db, 'alex');
    expect(alex?.displayName).toBe('Alex');
    expect(alex?.profile.base).toEqual({ acidity: 2, sweetness: 2, tannin: 4, body: 4 });
    await saveProfile(db, 'alex', 'Alex', { ...alex!.profile, base: { acidity: 5, sweetness: 5, tannin: 5, body: 5 } });
    await seedProfilesIfEmpty(db);
    expect((await getProfile(db, 'alex'))?.profile.base.acidity).toBe(5);
    expect(await getProfile(db, 'nobody')).toBeNull();
  });
});

describe('wines', () => {
  it('upsert keeps the first write and bumps scan_count', async () => {
    const db = createFakeDb();
    expect(await getWine(db, testWine.id)).toBeNull();
    await upsertWine(db, testWine);
    expect(await getWine(db, testWine.id)).toMatchObject({ ...testWine, scanCount: 1 });
    await upsertWine(db, { ...testWine, acidity: 5, source: 'wonder' });
    expect(await getWine(db, testWine.id)).toMatchObject({ ...testWine, scanCount: 2 });
  });
});

describe('scans', () => {
  it('inserts, reads back, sets feedback and stats', async () => {
    const db = createFakeDb();
    const today = new Date().toISOString().slice(0, 10);
    const first = await insertScan(db, { userId: 'alex', wineId: 'w1', score: 78, buddies: 'ana,luis', cacheHit: 0, readBy: 'spark', latencyMs: 10 });
    const second = await insertScan(db, { userId: 'alex', wineId: 'w1', score: 78, buddies: null, cacheHit: 1, readBy: 'spark', latencyMs: 5 });
    expect([first, second]).toEqual([1, 2]);
    expect(await getScan(db, 1)).toEqual({ id: 1, userId: 'alex', wineId: 'w1' });
    expect(await getScan(db, 999)).toBeNull();
    await setScanFeedback(db, 1, 'loved');
    expect(db.tables.scans[0].feedback).toBe('loved');
    expect(await scanStats(db, today)).toEqual({ scans: 2, cacheHits: 1 });
    expect(await scanStats(db, '2000-01-01')).toEqual({ scans: 0, cacheHits: 0 });
  });
});

describe('resetDemo', () => {
  it('clears scans, re-seeds profiles, keeps wines', async () => {
    const db = createFakeDb();
    await seedProfilesIfEmpty(db);
    await upsertWine(db, testWine);
    await insertScan(db, { userId: 'alex', wineId: testWine.id, score: 80, buddies: null, cacheHit: 0, readBy: 'spark', latencyMs: 1 });
    const alex = (await getProfile(db, 'alex'))!;
    await saveProfile(db, 'alex', 'Alex', { ...alex.profile, base: { acidity: 5, sweetness: 5, tannin: 5, body: 5 } });
    await resetDemo(db);
    const today = new Date().toISOString().slice(0, 10);
    expect(await scanStats(db, today)).toEqual({ scans: 0, cacheHits: 0 });
    expect((await getProfile(db, 'alex'))?.profile.base).toEqual({ acidity: 2, sweetness: 2, tannin: 4, body: 4 });
    expect(await getWine(db, testWine.id)).not.toBeNull();
  });
});
