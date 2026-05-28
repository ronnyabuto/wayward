import { getDurationSeconds } from './services/traffic.js';

const BUFFER_MIN = 8;

function fmtTime(date) {
  const s = date.toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Nairobi',
  });
  return s.replace(/^00:/, '12:');
}
import { dbGetAllWatches, dbDeleteWatch, dbSetFailCount, dbLogTraffic, dbLogTrafficPool,
         dbGetScheduledPendingIntents, dbDeletePendingIntent } from './db.js';
import { commitWatch } from './commands/watch.js';
import { logger } from './utils/logger.js';

export const watches = new Map();

// setTimeout handles for scheduled_watch pending intents, keyed by pending_intent id.
const pendingTimers = new Map();

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Schedule a single pending_intents row to fire at row.fire_at.
// Called both at startup (for rows restored from DB) and inline when a new
// far-future depart creates a scheduled_watch.
export function scheduleTimedWatch(bot, row) {
  const delayMs = Math.max(0, row.fire_at * 1000 - Date.now());
  const handle = setTimeout(async () => {
    pendingTimers.delete(row.id);
    dbDeletePendingIntent(row.id);

    const originShort  = row.origin.split(',')[0];
    const destShort    = row.destination.split(',')[0];
    const arriveByDate = row.arrive_at_sec ? new Date(row.arrive_at_sec * 1000) : null;
    const deadlineStr  = arriveByDate ? fmtTime(arriveByDate) : null;

    // Live traffic check at departure time.
    const routeOrigin = row.origin_place_id ? { placeId: row.origin_place_id } : row.origin;
    const routeDest   = row.dest_place_id   ? { placeId: row.dest_place_id   } : row.destination;
    let result;
    try {
      result = await getDurationSeconds(routeOrigin, routeDest);
    } catch (err) {
      logger.warn({ err, chatId: row.chat_id }, 'scheduled watch traffic check failed');
      result = null;
    }

    try {
      if (!result) {
        // Can't reach the API — fall back to continuous polling.
        commitWatch(row.chat_id, row.origin, row.destination, row.threshold_min,
                    row.origin_place_id ?? null, row.dest_place_id ?? null);
        await bot.sendMessage(row.chat_id,
          `Couldn't check traffic right now — watching ${originShort} → ${destShort} and will ping you when it's time to leave.`);
        return;
      }

      const currentMin   = Math.round(result.seconds / 60);
      const nowMs        = Date.now();
      const latestDep    = arriveByDate
        ? new Date(arriveByDate.getTime() - (currentMin + BUFFER_MIN) * 60_000)
        : null;
      const minUntilDep  = latestDep ? Math.round((latestDep.getTime() - nowMs) / 60_000) : null;

      if (latestDep && minUntilDep <= 0) {
        await bot.sendMessage(row.chat_id,
          `⚠️ Leave right now — ${originShort} → ${destShort} is ${currentMin} min and you're cutting it close for ${deadlineStr}.`);
        return;
      }

      // Traffic worse than predicted — warn and start continuous polling.
      if (currentMin > row.threshold_min) {
        commitWatch(row.chat_id, row.origin, row.destination, row.threshold_min,
                    row.origin_place_id ?? null, row.dest_place_id ?? null);
        const depStr = latestDep ? ` Leave by ${fmtTime(latestDep)} — ${minUntilDep} min from now.` : '';
        await bot.sendMessage(row.chat_id,
          `🔴 Traffic is heavier than expected — ${originShort} → ${destShort} is ${currentMin} min.${depStr} I'll ping you when it eases.`);
        return;
      }

      // On track — give a live departure nudge.
      const depStr = latestDep
        ? `Leave by ${fmtTime(latestDep)} — ${minUntilDep} min from now.`
        : `Leave when you're ready.`;
      const deadlineCtx = deadlineStr ? ` You'll arrive before ${deadlineStr}.` : '';
      await bot.sendMessage(row.chat_id,
        `🟢 ${originShort} → ${destShort} is ${currentMin} min right now. ${depStr}${deadlineCtx}`);
    } catch (err) {
      logger.warn({ err, chatId: row.chat_id }, 'scheduled watch notify failed');
    }
  }, delayMs);
  pendingTimers.set(row.id, handle);
}

// Restore scheduled watches from DB after a PM2 restart.
export function loadScheduledPendingIntents(bot) {
  const rows = dbGetScheduledPendingIntents();
  for (const row of rows) scheduleTimedWatch(bot, row);
  if (rows.length > 0) logger.info({ count: rows.length }, 'Restored scheduled watches from database.');
}

export function loadWatchesFromDb() {
  for (const row of dbGetAllWatches()) {
    watches.set(row.id, {
      chatId:          row.chat_id,
      origin:          row.origin,
      destination:     row.destination,
      originPlaceId:   row.origin_place_id ?? null,
      destPlaceId:     row.dest_place_id   ?? null,
      thresholdMinutes: row.threshold_min,
      failCount:       row.fail_count,
      active:          true,
    });
  }
  if (watches.size > 0) {
    logger.info({ count: watches.size }, 'Restored watches from database.');
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
      logger.error({ err, watchId }, 'watch check failed');
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

  // Dead man's switch: ping Healthchecks.io after every scheduler cycle so an
  // alert fires if the process stops running. Configure HEALTHCHECK_UUID in .env.
  if (process.env.HEALTHCHECK_UUID) {
    fetch(`https://hc-ping.com/${process.env.HEALTHCHECK_UUID}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(e => logger.warn({ err: e }, 'healthcheck ping failed'));
  }
}

async function checkWatch(bot, watchId, watch) {
  // Prefer placeId-based routing (more accurate access-point resolution);
  // fall back to the stored address string for watches created before this migration.
  const routeOrigin = watch.originPlaceId ? { placeId: watch.originPlaceId } : watch.origin;
  const routeDest   = watch.destPlaceId   ? { placeId: watch.destPlaceId   } : watch.destination;

  const result = await getDurationSeconds(routeOrigin, routeDest);
  if (result === null) return;

  // Reset failure counter on a successful API response.
  watch.failCount = 0;
  dbSetFailCount(watchId, 0);

  dbLogTraffic(watch.chatId, watch.origin, watch.destination, result.seconds, result.staticSeconds);
  if (watch.originPlaceId && watch.destPlaceId) {
    dbLogTrafficPool(watch.originPlaceId, watch.destPlaceId, result.seconds);
  }

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
