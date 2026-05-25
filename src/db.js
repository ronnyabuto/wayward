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
