import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNairobiComponents } from './utils/time.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_PATH = join(DATA_DIR, 'wayward.db');

let db;

export function initDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);

  // WAL mode: better write throughput for frequent traffic logging.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

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
  `);
}

// ── Watches ──────────────────────────────────────────────────────────────────

export function dbGetAllWatches() {
  return db.prepare('SELECT * FROM watches').all();
}

export function dbInsertWatch(chatId, origin, destination, thresholdMinutes) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO watches (chat_id, origin, destination, threshold_min) VALUES (?, ?, ?, ?)')
    .run(chatId, origin, destination, thresholdMinutes);
  return Number(lastInsertRowid);
}

export function dbDeleteWatch(id) {
  db.prepare('DELETE FROM watches WHERE id = ?').run(id);
}

export function dbSetFailCount(id, failCount) {
  db.prepare('UPDATE watches SET fail_count = ? WHERE id = ?').run(failCount, id);
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
    const sanitized = queryText.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
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
