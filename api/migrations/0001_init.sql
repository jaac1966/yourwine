CREATE TABLE wines (
  id          TEXT PRIMARY KEY,
  producer    TEXT,
  name        TEXT NOT NULL,
  vintage     INTEGER,
  region      TEXT,
  country     TEXT,
  grapes      TEXT,
  abv         REAL,
  color       TEXT NOT NULL CHECK (color IN ('red','white','rose','sparkling')),
  acidity     REAL NOT NULL,
  sweetness   REAL NOT NULL,
  tannin      REAL NOT NULL,
  body        REAL NOT NULL,
  source      TEXT NOT NULL,
  confidence  REAL,
  scan_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profiles (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  base          TEXT NOT NULL,
  overlays      TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  wine_id     TEXT NOT NULL,
  score       INTEGER NOT NULL,
  buddies     TEXT,
  cache_hit   INTEGER NOT NULL DEFAULT 0,
  read_by     TEXT,
  latency_ms  INTEGER,
  feedback    TEXT CHECK (feedback IN ('loved','not_for_me') OR feedback IS NULL),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX scans_user_created ON scans(user_id, created_at);
