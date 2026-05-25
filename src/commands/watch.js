import { watches } from '../scheduler.js';
import { dbInsertWatch, dbDeleteWatch } from '../db.js';
import { getDurationSeconds } from '../services/traffic.js';

// Core logic — shared by the explicit /watch command and the NLP path in bot.js.
export async function handleWatch(bot, chatId, origin, destination, threshold) {
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
        `🟢 Traffic is already good — ${origin} → ${destination} is ${currentMin} min right now. Leave when you're ready.`
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

  const watchId = commitWatch(chatId, origin, destination, threshold);
  await bot.sendMessage(
    chatId,
    `Watching ${origin} → ${destination}. I'll message you when the drive drops under ${threshold} min.\n\nWatch ID: #${watchId} — use /stopwatch ${watchId} to cancel.`
  );
}

// Persist a watch to DB and memory without any validation or messaging.
// Used by handleWatch (above) and handleDepart, which already validated the route.
export function commitWatch(chatId, origin, destination, threshold) {
  const watchId = dbInsertWatch(chatId, origin, destination, threshold);
  watches.set(watchId, { chatId, origin, destination, thresholdMinutes: threshold, failCount: 0, active: true });
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
      console.error('stopwatch handler error:', err.message);
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
      const lines = active.map(([id, w]) => `#${id} — ${w.origin} → ${w.destination} (alert at ≤ ${w.thresholdMinutes} min)`);
      await bot.sendMessage(chatId, `Active watches:\n\n${lines.join('\n')}`);
    } catch (err) {
      console.error('watches handler error:', err.message);
    }
  });
}
