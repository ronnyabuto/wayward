import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNairobiComponents } from './utils/time.js';
import { logger } from './utils/logger.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_PATH = join(DATA_DIR, 'wayward.db');

let db;

export function initDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);

  // WAL mode: better write throughput for frequent traffic logging.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Prevents SQLITE_BUSY if two async operations race for a write lock in the same process.
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         INTEGER NOT NULL,
      origin          TEXT    NOT NULL,
      destination     TEXT    NOT NULL,
      threshold_min   INTEGER NOT NULL,
      fail_count      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS saved_places (
      chat_id  INTEGER NOT NULL,
      name     TEXT    NOT NULL,
      address  TEXT    NOT NULL,
      PRIMARY KEY (chat_id, name)
    );

    CREATE TABLE IF NOT EXISTS traffic_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      INTEGER NOT NULL,
      origin       TEXT    NOT NULL,
      destination  TEXT    NOT NULL,
      day_of_week  INTEGER NOT NULL,
      hour_of_day  INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL,
      static_sec   INTEGER NOT NULL,
      recorded_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traffic_lookup
      ON traffic_history (chat_id, origin, destination, day_of_week, hour_of_day, recorded_at);

    CREATE TABLE IF NOT EXISTS memory_turns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      user_msg    TEXT    NOT NULL,
      bot_intent  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_turns_fts
      USING fts5(user_msg, content='memory_turns', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS memory_turns_ai
      AFTER INSERT ON memory_turns BEGIN
        INSERT INTO memory_turns_fts(rowid, user_msg) VALUES (new.id, new.user_msg);
      END;

    CREATE TRIGGER IF NOT EXISTS memory_turns_ad
      AFTER DELETE ON memory_turns BEGIN
        INSERT INTO memory_turns_fts(memory_turns_fts, rowid, user_msg)
          VALUES ('delete', old.id, old.user_msg);
      END;

    CREATE TABLE IF NOT EXISTS user_facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      predicate   TEXT    NOT NULL,
      object      TEXT    NOT NULL,
      valid_from  INTEGER,
      valid_to    INTEGER,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_facts_user
      ON user_facts (user_id, valid_to);

    CREATE TABLE IF NOT EXISTS departure_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      origin      TEXT    NOT NULL,
      destination TEXT    NOT NULL,
      day_of_week INTEGER NOT NULL,
      hour_of_day INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dep_lookup
      ON departure_events (user_id, origin, destination, day_of_week);

    -- Canonical place registry: Google place_id is permanently cacheable per ToS.
    -- One row per physical place; identified by Google's stable place_id string.
    CREATE TABLE IF NOT EXISTS places (
      place_id     TEXT    PRIMARY KEY,
      display_name TEXT    NOT NULL,
      lat          REAL    NOT NULL,
      lon          REAL    NOT NULL,
      refreshed_at INTEGER NOT NULL
    );

    -- Geocode cache: maps a normalised query string → place_id.
    -- Many query strings can resolve to the same place_id without conflict.
    -- cached_at tracks when lat/lon was last fetched (30-day ToS limit for coordinates).
    CREATE TABLE IF NOT EXISTS place_queries (
      queried_as TEXT    PRIMARY KEY,
      place_id   TEXT    NOT NULL,
      cached_at  INTEGER NOT NULL
    );

    -- Anonymised, shared traffic observations pooled across all users.
    -- AUTOINCREMENT id (not composite PK) so concurrent writes within the same
    -- second are never silently dropped by INSERT OR IGNORE.
    CREATE TABLE IF NOT EXISTS traffic_pool (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_place_id      TEXT    NOT NULL,
      destination_place_id TEXT    NOT NULL,
      day_of_week          INTEGER NOT NULL,
      hour_slot            INTEGER NOT NULL,
      duration_sec         INTEGER NOT NULL,
      recorded_at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pool_lookup
      ON traffic_pool (origin_place_id, destination_place_id, day_of_week, hour_slot, recorded_at);

    -- Pending intents: the bot's working memory of promises made to the user.
    -- Two types:
    --   'watch_offer'    – bot just gave a departure forecast; expires in 30 min.
    --                      If user confirms ("ping me", "yes"), creates a watch immediately.
    --   'scheduled_watch'– bot promised to start watching at fire_at (Unix epoch sec).
    --                      Startup loader restores these after PM2 restarts.
    CREATE TABLE IF NOT EXISTS pending_intents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      intent_type     TEXT    NOT NULL,
      origin          TEXT    NOT NULL,
      destination     TEXT    NOT NULL,
      threshold_min   INTEGER,
      fire_at         INTEGER,
      origin_place_id TEXT,
      dest_place_id   TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_intents (user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_pending_fire ON pending_intents (fire_at) WHERE fire_at IS NOT NULL;
  `);

  // Migrate traffic_pool: if it was created without the id column (old composite PK),
  // recreate it. This only affects installs from today before this fix.
  const poolHasId = db.prepare(
    `SELECT COUNT(*) AS n FROM pragma_table_info('traffic_pool') WHERE name = 'id'`
  ).get().n;
  if (!poolHasId) {
    db.exec(`DROP TABLE IF EXISTS traffic_pool`);
    db.exec(`
      CREATE TABLE traffic_pool (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_place_id      TEXT    NOT NULL,
        destination_place_id TEXT    NOT NULL,
        day_of_week          INTEGER NOT NULL,
        hour_slot            INTEGER NOT NULL,
        duration_sec         INTEGER NOT NULL,
        recorded_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pool_lookup
        ON traffic_pool (origin_place_id, destination_place_id, day_of_week, hour_slot, recorded_at);
    `);
  }

  // Migrate pending_intents: add table if this is an existing install without it.
  const hasPendingIntents = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pending_intents'`
  ).get().n;
  if (!hasPendingIntents) {
    db.exec(`
      CREATE TABLE pending_intents (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id         INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        intent_type     TEXT    NOT NULL,
        origin          TEXT    NOT NULL,
        destination     TEXT    NOT NULL,
        threshold_min   INTEGER,
        fire_at         INTEGER,
        origin_place_id TEXT,
        dest_place_id   TEXT,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_pending_user ON pending_intents (user_id, expires_at);
      CREATE INDEX idx_pending_fire ON pending_intents (fire_at) WHERE fire_at IS NOT NULL;
    `);
  }

  // Migrate watches table: add place_id columns if this is an existing install.
  const watchCols = new Set(
    db.prepare(`SELECT name FROM pragma_table_info('watches')`).all().map(r => r.name)
  );
  if (!watchCols.has('origin_place_id')) db.exec(`ALTER TABLE watches ADD COLUMN origin_place_id TEXT`);
  if (!watchCols.has('dest_place_id'))   db.exec(`ALTER TABLE watches ADD COLUMN dest_place_id TEXT`);

  logger.info('Database initialised.');
}

// ── Places & geocode cache ────────────────────────────────────────────────────

export function dbGetOrCreatePlace(placeId, displayName, lat, lon) {
  db.prepare(`
    INSERT INTO places (place_id, display_name, lat, lon, refreshed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(place_id) DO UPDATE SET
      display_name = excluded.display_name,
      lat          = excluded.lat,
      lon          = excluded.lon,
      refreshed_at = excluded.refreshed_at
  `).run(placeId, displayName, lat, lon, Math.floor(Date.now() / 1000));
}

export function dbCacheQuery(queriedAs, placeId) {
  db.prepare(`
    INSERT INTO place_queries (queried_as, place_id, cached_at)
    VALUES (?, ?, ?)
    ON CONFLICT(queried_as) DO UPDATE SET
      place_id  = excluded.place_id,
      cached_at = excluded.cached_at
  `).run(queriedAs, placeId, Math.floor(Date.now() / 1000));
}

// Returns { place_id, display_name, lat, lon, refreshed_at } or null.
export function dbFindPlaceByQuery(queriedAs) {
  return db.prepare(`
    SELECT p.place_id, p.display_name, p.lat, p.lon, p.refreshed_at
    FROM place_queries pq
    JOIN places p ON p.place_id = pq.place_id
    WHERE pq.queried_as = ?
  `).get(queriedAs) ?? null;
}

// ── Traffic pool (anonymised, shared across users) ────────────────────────────

export function dbLogTrafficPool(originPlaceId, destPlaceId, durationSec) {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  db.prepare(`
    INSERT INTO traffic_pool
      (origin_place_id, destination_place_id, day_of_week, hour_slot, duration_sec, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(originPlaceId, destPlaceId, dayOfWeek, hourOfDay, durationSec, Math.floor(Date.now() / 1000));
}

// Returns { avgMin, count } from pooled community data, or null if < 3 observations.
export function dbGetPoolTypical(originPlaceId, destPlaceId, dayOfWeek, hourOfDay) {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const row = db.prepare(`
    SELECT ROUND(AVG(duration_sec) / 60.0) AS avg_min, COUNT(*) AS count
    FROM traffic_pool
    WHERE origin_place_id = ? AND destination_place_id = ?
      AND day_of_week = ? AND hour_slot = ?
      AND recorded_at > ?
  `).get(originPlaceId, destPlaceId, dayOfWeek, hourOfDay, thirtyDaysAgo);
  if (!row || row.count < 3) return null;
  return { avgMin: Math.round(row.avg_min), count: row.count };
}

// ── Watches ──────────────────────────────────────────────────────────────────

export function dbGetAllWatches() {
  return db.prepare('SELECT * FROM watches').all();
}

export function dbInsertWatch(chatId, origin, destination, thresholdMinutes, originPlaceId = null, destPlaceId = null) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO watches (chat_id, origin, destination, threshold_min, origin_place_id, dest_place_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, origin, destination, thresholdMinutes, originPlaceId, destPlaceId);
  return Number(lastInsertRowid);
}

export function dbDeleteWatch(id) {
  db.prepare('DELETE FROM watches WHERE id = ?').run(id);
}

export function dbSetFailCount(id, failCount) {
  db.prepare('UPDATE watches SET fail_count = ? WHERE id = ?').run(failCount, id);
}

// ── Pending intents ───────────────────────────────────────────────────────────

// Returns the inserted row id.
export function dbInsertPendingIntent(userId, chatId, intentType, origin, destination, thresholdMin, fireAt, originPlaceId, destPlaceId) {
  const now = Math.floor(Date.now() / 1000);
  // watch_offer: 30-min TTL. scheduled_watch: expires 1 h after fire_at so it
  // auto-cleans if the process was down when the timer was supposed to fire.
  const expiresAt = fireAt ? fireAt + 3600 : now + 1800;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO pending_intents
      (chat_id, user_id, intent_type, origin, destination, threshold_min, fire_at,
       origin_place_id, dest_place_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, userId, intentType, origin, destination, thresholdMin ?? null,
         fireAt ?? null, originPlaceId ?? null, destPlaceId ?? null, now, expiresAt);
  return Number(lastInsertRowid);
}

// Returns the most recent non-expired pending intent for this user, or null.
export function dbGetActivePendingIntent(userId) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT * FROM pending_intents
    WHERE user_id = ? AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, now) ?? null;
}

export function dbDeletePendingIntent(id) {
  db.prepare('DELETE FROM pending_intents WHERE id = ?').run(id);
}

// Returns all scheduled_watch rows whose fire_at is still in the future.
// Called on startup to restore timers after a PM2 restart.
export function dbGetScheduledPendingIntents() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT * FROM pending_intents
    WHERE intent_type = 'scheduled_watch' AND fire_at IS NOT NULL AND fire_at > ?
  `).all(now);
}

// ── Saved places ──────────────────────────────────────────────────────────────

export function dbGetSavedPlaces(chatId) {
  const rows = db.prepare('SELECT name, address FROM saved_places WHERE chat_id = ?').all(chatId);
  return Object.fromEntries(rows.map(r => [r.name, r.address]));
}

export function dbSetPlace(chatId, name, address) {
  db.prepare('INSERT OR REPLACE INTO saved_places (chat_id, name, address) VALUES (?, ?, ?)')
    .run(chatId, name.toLowerCase(), address);
}

// ── Traffic history ───────────────────────────────────────────────────────────

export function dbLogTraffic(chatId, origin, destination, durationSec, staticSec) {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  db.prepare(`
    INSERT INTO traffic_history
      (chat_id, origin, destination, day_of_week, hour_of_day, duration_sec, static_sec, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, origin, destination, dayOfWeek, hourOfDay, durationSec, staticSec,
         Math.floor(Date.now() / 1000));
}

// ── Memory turns ──────────────────────────────────────────────────────────────

const MAX_TURNS_STORED     = 50;
const MAX_TURNS_CONTEXT    = 5;
const MAX_FTS_HITS         = 8;
const RECENCY_HALF_LIFE_SEC = 7 * 24 * 60 * 60; // 7-day half-life for temporal decay

// Persist a completed exchange. Prunes the oldest turns beyond MAX_TURNS_STORED.
export function dbPersistTurn(userId, chatId, userMsg, intentJson) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO memory_turns (chat_id, user_id, user_msg, bot_intent, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, userId, userMsg, intentJson, now);

  db.prepare(`
    DELETE FROM memory_turns
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM memory_turns WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `).run(userId, userId, MAX_TURNS_STORED);
}

// Hybrid retrieval: most recent turns + FTS5 keyword matches from older stored turns,
// merged by temporal decay score and returned oldest-first for the Gemini context.
// After a bot restart the volatile window is gone — this restores it from SQLite.
export function dbRetrieveRelevantTurns(userId, queryText) {
  const now = Math.floor(Date.now() / 1000);

  const recentTurns = db.prepare(`
    SELECT id, user_msg, bot_intent, created_at FROM memory_turns
    WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, MAX_TURNS_CONTEXT);

  const recentIds = new Set(recentTurns.map(t => t.id));

  let ftsTurns = [];
  try {
    const sanitized = queryText.replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    if (sanitized.length > 0) {
      ftsTurns = db.prepare(`
        SELECT m.id, m.user_msg, m.bot_intent, m.created_at, -rank AS fts_score
        FROM memory_turns_fts
        JOIN memory_turns m ON m.id = memory_turns_fts.rowid
        WHERE memory_turns_fts MATCH ? AND m.user_id = ?
        ORDER BY rank LIMIT ?
      `).all(sanitized, userId, MAX_FTS_HITS);
    }
  } catch {
    // Malformed FTS query — fall back to recency-only.
  }

  // Recent turns get Infinity so they always outrank older FTS hits.
  const merged = recentTurns.map(t => ({ ...t, finalScore: Infinity }));
  for (const row of ftsTurns) {
    if (recentIds.has(row.id)) continue;
    const ageSec = now - row.created_at;
    const decay  = Math.exp(-ageSec / RECENCY_HALF_LIFE_SEC);
    merged.push({ ...row, finalScore: row.fts_score * decay });
  }

  return merged
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, MAX_TURNS_CONTEXT)
    .sort((a, b) => a.created_at - b.created_at)  // oldest-first for Gemini
    .map(t => ({ userMessage: t.user_msg, modelResponse: t.bot_intent }));
}

// ── Temporal facts ────────────────────────────────────────────────────────────

// Upsert a fact: invalidates any existing active (subject, predicate) pair for this
// user before inserting the new value, preserving history via valid_to timestamping.
export function dbUpsertFact(userId, subject, predicate, object) {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare(`
      UPDATE user_facts SET valid_to = ?
      WHERE user_id = ? AND subject = ? AND predicate = ? AND valid_to IS NULL
    `).run(now, userId, subject, predicate);
    db.prepare(`
      INSERT INTO user_facts (user_id, subject, predicate, object, valid_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, subject, predicate, object, now, now);
  })();
}

export function dbGetActiveFacts(userId) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT subject, predicate, object FROM user_facts
    WHERE user_id = ? AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY created_at DESC
  `).all(userId, now);
}

// ── Departure events ──────────────────────────────────────────────────────────

export function dbLogDeparture(userId, origin, destination) {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  db.prepare(`
    INSERT INTO departure_events (user_id, origin, destination, day_of_week, hour_of_day, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, origin, destination, dayOfWeek, hourOfDay, Math.floor(Date.now() / 1000));
}

// Returns the most common departure hour for this user/route/weekday, or null
// if fewer than 3 data points exist (not enough to establish a reliable pattern).
export function dbGetTypicalDepartureHour(userId, origin, destination, dayOfWeek) {
  const row = db.prepare(`
    SELECT hour_of_day, COUNT(*) AS cnt
    FROM departure_events
    WHERE user_id = ? AND origin = ? AND destination = ? AND day_of_week = ?
    GROUP BY hour_of_day ORDER BY cnt DESC LIMIT 1
  `).get(userId, origin, destination, dayOfWeek);
  return row && row.cnt >= 3 ? row.hour_of_day : null;
}

// Returns { avgMin, count } for the user's personal history on this route/slot,
// or null if fewer than 3 data points exist in the last 60 days.
export function dbGetPersonalTypical(chatId, origin, destination, dayOfWeek, hourOfDay) {
  const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
  const row = db.prepare(`
    SELECT ROUND(AVG(duration_sec) / 60.0) AS avg_min, COUNT(*) AS count
    FROM traffic_history
    WHERE chat_id = ? AND origin = ? AND destination = ?
      AND day_of_week = ? AND hour_of_day = ?
      AND recorded_at > ?
  `).get(chatId, origin, destination, dayOfWeek, hourOfDay, sixtyDaysAgo);

  if (!row || row.count < 3) return null;
  return { avgMin: Math.round(row.avg_min), count: row.count };
}
