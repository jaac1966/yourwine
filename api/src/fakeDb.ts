import type { D1, D1Stmt } from './db';

// Minimal in-memory D1 stand-in for tests. Handles exactly the queries in db.ts.
export type FakeRow = Record<string, unknown>;
export type FakeDb = D1 & {
  tables: { profiles: Map<string, FakeRow>; wines: Map<string, FakeRow>; scans: FakeRow[] };
};

export function createFakeDb(): FakeDb {
  const profiles = new Map<string, FakeRow>();
  const wines = new Map<string, FakeRow>();
  const scans: FakeRow[] = [];
  let scanSeq = 0;

  function exec(stmt: string, args: unknown[]): unknown {
    if (stmt.startsWith('SELECT user_id, display_name, base, overlays FROM profiles')) {
      return profiles.get(args[0] as string) ?? null;
    }
    if (stmt.startsWith('INSERT INTO profiles')) {
      const [user_id, display_name, base, overlays] = args as string[];
      profiles.set(user_id, { user_id, display_name, base, overlays });
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (stmt === 'SELECT COUNT(*) AS n FROM profiles') {
      return { n: profiles.size };
    }
    if (stmt.startsWith('SELECT id, producer, name')) {
      return wines.get(args[0] as string) ?? null;
    }
    if (stmt.startsWith('INSERT INTO wines')) {
      const [id, producer, name, vintage, region, country, grapes, abv, color, acidity, sweetness, tannin, body, source, confidence] =
        args as [string, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown];
      const prev = wines.get(id);
      if (!prev) {
        wines.set(id, {
          id, producer, name, vintage, region, country, grapes, abv, color,
          acidity, sweetness, tannin, body, source, confidence, scan_count: 1,
        });
      } else {
        prev.scan_count = (prev.scan_count as number) + 1;
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (stmt.startsWith('INSERT INTO scans')) {
      const [user_id, wine_id, score, buddies, cache_hit, read_by, latency_ms] = args;
      scanSeq += 1;
      scans.push({
        id: scanSeq, user_id, wine_id, score, buddies, cache_hit, read_by, latency_ms,
        feedback: null, created_at: new Date().toISOString(),
      });
      return { meta: { last_row_id: scanSeq, changes: 1 } };
    }
    if (stmt.startsWith('SELECT id, user_id, wine_id FROM scans')) {
      return scans.find((s) => s.id === args[0]) ?? null;
    }
    if (stmt.startsWith('UPDATE scans SET feedback')) {
      const row = scans.find((s) => s.id === args[1]);
      if (row) row.feedback = args[0];
      return { meta: { last_row_id: 0, changes: row ? 1 : 0 } };
    }
    if (stmt === 'DELETE FROM scans') {
      scans.length = 0;
      return { meta: { last_row_id: 0, changes: 0 } };
    }
    if (stmt.startsWith('SELECT COUNT(*) AS scans')) {
      const rows = scans.filter((s) => (s.created_at as string).slice(0, 10) === args[0]);
      return { scans: rows.length, hits: rows.reduce((n, s) => n + (s.cache_hit as number), 0) };
    }
    throw new Error(`fakeDb: unhandled query: ${stmt}`);
  }

  const stmtFor = (stmt: string, args: unknown[]): D1Stmt => ({
    bind: () => {
      throw new Error('fakeDb: double bind');
    },
    first: async <T,>() => exec(stmt, args) as T | null,
    all: async <T,>() => ({ results: [] as T[] }),
    run: async () => exec(stmt, args) as { meta: { last_row_id: number; changes: number } },
  });

  const db: D1 = {
    prepare(query: string): D1Stmt {
      const stmt = query.replace(/\s+/g, ' ').trim();
      return {
        bind: (...args: unknown[]) => stmtFor(stmt, args),
        first: async <T,>() => exec(stmt, []) as T | null,
        all: async <T,>() => ({ results: [] as T[] }),
        run: async () => exec(stmt, []) as { meta: { last_row_id: number; changes: number } },
      };
    },
  };
  return Object.assign(db, { tables: { profiles, wines, scans } });
}
