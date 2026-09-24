import { watches } from '../scheduler.js';
import { dbInsertWatch, dbDeleteWatch } from '../db.js';
import { getDurationSeconds } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { logger } from '../utils/logger.js';
import { fmtTime } from '../utils/time.js';

// Core logic — shared by the explicit /watch command and the NLP path in bot.js.
// Geocodes origin/destination here so the scheduler can use placeId-based routing.
export async function handleWatch(bot, chatId, originStr, destinationStr, threshold) {
  let origin, destination;
  try {
    [origin, destination] = await Promise.all([geocode(originStr), geocode(destinationStr)]);
  } catch (err) {
    if (err instanceof GeocodeNotFoundError) {
      await bot.sendMessage(chatId, err.message);
    } else {
      logger.error({ err, chatId }, 'watch geocode error');
      await bot.sendMessage(chatId, 'Something went wrong looking up those places. Try again in a moment.');
    }
    return;
  }

  // Check current conditions before committing to a watch.
  let current = null;
  try {
    current = await getDurationSeconds(origin, destination);
  } catch {
    // Can't reach the traffic API right now — fall through and set the watch anyway.
  }

  if (current !== null) {
    const currentMin = Math.round(current.seconds / 60);
    // Use whichever is lower — at low-traffic hours the live time can beat the
    // static model, so the true floor is the minimum of both.
    const floorMin = Math.round(Math.min(current.seconds, current.staticSeconds) / 60);

    // Already at or under threshold — fire immediately, no watch needed.
    if (currentMin <= threshold) {
      await bot.sendMessage(
        chatId,
        `🟢 Traffic is already good — ${originStr} → ${destinationStr} is ${currentMin} min right now. Leave when you're ready.`
      );
      return;
    }

    // Threshold is below the best possible time for this route — will never fire.
    if (threshold < floorMin) {
      await bot.sendMessage(
        chatId,
        `That threshold isn't reachable — the fastest this route goes is ${floorMin} min. Try a threshold above ${floorMin} min.`
      );
      return;
    }
  }

  const watchId = commitWatch(chatId, originStr, destinationStr, threshold, origin.placeId, destination.placeId);
  const until = fmtTime(new Date(watches.get(watchId).expiresAt * 1000));
  await bot.sendMessage(
    chatId,
    `Watching ${originStr} → ${destinationStr} until ${until}. I'll message you when the drive drops under ${threshold} min.\n\nWatch ID: #${watchId} — use /stopwatch ${watchId} to cancel.`
  );
}

// How long a watch with no deadline keeps polling. A watch answers "when can I
// leave for this trip", which is a same-day question — long enough to outlast
// an evening rush (roughly 5–8pm in Nairobi) from its start, short enough that
// a threshold traffic never reaches doesn't poll the Routes API for days.
const WATCH_LIFETIME_SEC = 4 * 60 * 60;

export function defaultWatchExpiry() {
  return Math.floor(Date.now() / 1000) + WATCH_LIFETIME_SEC;
}

// Persist a watch to DB and memory without any validation or messaging.
// Used by handleWatch (above) and handleDepart, which already geocoded the route.
// expiresAt (unix seconds): pass the user's deadline when there is one — an
// alert after it is useless. Otherwise the watch gets the default lifetime.
export function commitWatch(chatId, origin, destination, threshold, originPlaceId = null, destPlaceId = null, expiresAt = null) {
  const expiry = expiresAt ?? defaultWatchExpiry();
  const watchId = dbInsertWatch(chatId, origin, destination, threshold, originPlaceId, destPlaceId, expiry);
  watches.set(watchId, {
    chatId,
    origin,
    destination,
    originPlaceId,
    destPlaceId,
    thresholdMinutes: threshold,
    expiresAt: expiry,
    bestMin: null,
    bestAt: null,
    failCount: 0,
    active: true,
  });
  return watchId;
}

export function registerStopwatch(bot) {
  bot.onText(/^\/stopwatch (\d+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
      const watchId = parseInt(match[1], 10);
      const watch = watches.get(watchId);
      if (!watch || watch.chatId !== chatId) {
        await bot.sendMessage(chatId, `No active watch #${watchId} found.`);
        return;
      }
      watches.delete(watchId);
      dbDeleteWatch(watchId);
      await bot.sendMessage(chatId, `Stopped watch #${watchId} (${watch.origin} → ${watch.destination}).`);
    } catch (err) {
      logger.error({ err, chatId }, 'stopwatch handler error');
    }
  });
}

export function registerListWatches(bot) {
  bot.onText(/^\/watches$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const active = [...watches.entries()].filter(([, w]) => w.chatId === chatId && w.active);
      if (!active.length) {
        await bot.sendMessage(chatId, 'You have no active watches. Start one or just tell me where you need to go.');
        return;
      }
      const lines = active.map(([id, w]) => `#${id} — ${w.origin} → ${w.destination} (alert at ≤ ${w.thresholdMinutes} min, until ${fmtTime(new Date(w.expiresAt * 1000))})`);
      await bot.sendMessage(chatId, `Active watches:\n\n${lines.join('\n')}`);
    } catch (err) {
      logger.error({ err, chatId }, 'watches handler error');
    }
  });
}
