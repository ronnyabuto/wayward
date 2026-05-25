import { getDurationSeconds } from './services/traffic.js';
import { dbGetAllWatches, dbDeleteWatch, dbSetFailCount, dbLogTraffic } from './db.js';

export const watches = new Map();

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export function loadWatchesFromDb() {
  for (const row of dbGetAllWatches()) {
    watches.set(row.id, {
      chatId: row.chat_id,
      origin: row.origin,
      destination: row.destination,
      thresholdMinutes: row.threshold_min,
      failCount: row.fail_count,
      active: true,
    });
  }
  if (watches.size > 0) {
    console.log(`Restored ${watches.size} watch(es) from database.`);
  }
}

export function startScheduler(bot) {
  setInterval(() => pollAllWatches(bot), POLL_INTERVAL_MS);
}

async function pollAllWatches(bot) {
  for (const [watchId, watch] of watches) {
    if (!watch.active) continue;
    try {
      await checkWatch(bot, watchId, watch);
    } catch (err) {
      console.error(`Watch #${watchId} check failed:`, err.message);
      watch.failCount = (watch.failCount ?? 0) + 1;
      dbSetFailCount(watchId, watch.failCount);

      // After 6 consecutive failures (1 hour) notify the user and stop the watch.
      if (watch.failCount >= 6) {
        watch.active = false;
        watches.delete(watchId);
        dbDeleteWatch(watchId);
        try {
          await bot.sendMessage(
            watch.chatId,
            `Something went wrong checking ${watch.origin} → ${watch.destination} repeatedly. Watch #${watchId} has been stopped. Try again with /watch.`
          );
        } catch {
          // If we can't reach Telegram either, nothing more we can do.
        }
      }
    }
  }
}

async function checkWatch(bot, watchId, watch) {
  const result = await getDurationSeconds(watch.origin, watch.destination);
  if (result === null) return;

  // Reset failure counter on a successful API response.
  watch.failCount = 0;
  dbSetFailCount(watchId, 0);
  dbLogTraffic(watch.chatId, watch.origin, watch.destination, result.seconds, result.staticSeconds);

  const minutes = Math.round(result.seconds / 60);
  if (minutes <= watch.thresholdMinutes) {
    watch.active = false;
    watches.delete(watchId);
    dbDeleteWatch(watchId);
    await bot.sendMessage(
      watch.chatId,
      `🟢 Leave now. ${watch.origin} → ${watch.destination} is ${minutes} min right now.`
    );
  }
}
