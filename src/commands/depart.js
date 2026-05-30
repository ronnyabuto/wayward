import { getDurationSeconds } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { commitWatch } from './watch.js';
import { dbLogTraffic, dbGetPersonalTypical, dbLogTrafficPool, dbGetPoolTypical, dbInsertPendingIntent, dbGetProbeCache, dbSetProbeCache } from '../db.js';
import { scheduleTimedWatch } from '../scheduler.js';
import { getNairobiComponents } from '../utils/time.js';
import { logger } from '../utils/logger.js';

const ACCEPTABLE_RATIO = 1.2;
const BUFFER_MIN = 8;       // minutes subtracted from latest departure as a parking/settling buffer
const FAR_FUTURE_MIN = 240; // deadlines > 4 h away use predictive traffic, not current

function fmtTime(date) {
  const s = date.toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Nairobi',
  });
  // en-KE ICU data renders noon/midnight as "00:xx" instead of "12:xx" on some runtimes.
  return s.replace(/^00:/, '12:');
}

// Parse an NLP-produced "HH:MM" (Nairobi local 24 h) into a UTC Date.
// If the resulting moment is already in the past, adds 24 h (tomorrow).
function parseArriveBy(arriveByStr) {
  const [h, m] = arriveByStr.split(':').map(Number);
  const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no DST
  const nowMs = Date.now();
  const nairobiMs = nowMs + NAIROBI_OFFSET_MS;
  const midnightMs = nairobiMs - (nairobiMs % 86_400_000);
  const targetMs = midnightMs + (h * 60 + m) * 60_000 - NAIROBI_OFFSET_MS;
  return new Date(targetMs <= nowMs ? targetMs + 86_400_000 : targetMs);
}

export async function handleDepart(bot, chatId, originStr, destinationStr, arriveBy = null, userId = null) {
  let origin, destination;
  try {
    [origin, destination] = await Promise.all([geocode(originStr), geocode(destinationStr)]);
  } catch (err) {
    if (err instanceof GeocodeNotFoundError) {
      await bot.sendMessage(chatId, err.message);
    } else {
      logger.error({ err, chatId }, 'depart geocode error');
      await bot.sendMessage(chatId, 'Something went wrong looking up those places. Try again in a moment.');
    }
    return;
  }

  const dbId = userId ?? chatId;

  let current;
  try {
    current = await getDurationSeconds(origin, destination);
  } catch (err) {
    logger.error({ err, chatId }, 'depart traffic error');
    await bot.sendMessage(chatId, 'Could not fetch traffic right now. Try again in a moment.');
    return;
  }

  if (!current) {
    await bot.sendMessage(chatId, `No route found between ${originStr} and ${destinationStr}.`);
    return;
  }

  dbLogTraffic(dbId, origin.formatted, destination.formatted, current.seconds, current.staticSeconds);
  if (origin.placeId && destination.placeId) {
    dbLogTrafficPool(origin.placeId, destination.placeId, current.seconds);
  }

  const currentMin = Math.round(current.seconds / 60);
  const typicalMin = Math.round(current.staticSeconds / 60);

  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents();
  const personal   = dbGetPersonalTypical(dbId, origin.formatted, destination.formatted, dayOfWeek, hourOfDay);
  const pool       = !personal && origin.placeId && destination.placeId
    ? dbGetPoolTypical(origin.placeId, destination.placeId, dayOfWeek, hourOfDay)
    : null;

  const baselineMin    = personal?.avgMin ?? pool?.avgMin ?? typicalMin;
  const baselineSource = personal ? `your usual ${dayName} ${hourStr}`
    : pool   ? `community average ${dayName} ${hourStr}`
    : 'usual';
  const threshold = Math.ceil(baselineMin * ACCEPTABLE_RATIO);

  const originShort = originStr.split(',')[0];
  const destShort   = destinationStr.split(',')[0];
  const mapsLink    = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&travelmode=driving`;

  logger.info({ chatId, command: 'depart', origin: originStr, destination: destinationStr, arriveBy }, 'depart handled');

  if (arriveBy) {
    await handleDepartWithDeadline(
      bot, chatId, origin, destination, originStr, destinationStr,
      arriveBy, current, baselineMin, baselineSource, dbId, mapsLink,
    );
    return;
  }

  // Traffic is already acceptable — go now
  if (currentMin <= threshold) {
    const diff = currentMin - baselineMin;
    const context = diff < -2
      ? ` — ${Math.abs(diff)} min faster than ${baselineSource}`
      : diff > 2
      ? ` — ${diff} min slower than ${baselineSource}`
      : ` — about ${baselineSource}`;
    await bot.sendMessage(
      chatId,
      `🟢 Good time to head out — ${originShort} → ${destShort} is ${currentMin} min right now${context}. Leave when you're ready.\n${mapsLink}`
    );
    return;
  }

  // Traffic is heavy — find when it clears
  const baselineLabel = `${baselineSource} is ${baselineMin} min`;
  await bot.sendMessage(
    chatId,
    `🔴 Traffic is heavy — ${currentMin} min right now (${baselineLabel}). Checking when it should clear…`
  );

  const clearOffset = await findClearTime(origin, destination, threshold);

  if (clearOffset !== null) {
    const leaveAt = new Date(Date.now() + clearOffset * 60_000);
    await bot.sendMessage(
      chatId,
      `Find something to do for about ${clearOffset} min — traffic should ease around ${fmtTime(leaveAt)}. I'll message you when the drive drops under ${threshold} min.\n${mapsLink}`
    );
  } else {
    await bot.sendMessage(
      chatId,
      `Traffic stays heavy for at least the next 2 hours. I'll keep watching and message you when it improves.\n${mapsLink}`
    );
  }

  // Silently create the watch — no extra confirmation, we already told the user above.
  commitWatch(chatId, originStr, destinationStr, threshold, origin.placeId, destination.placeId);
}

// Query the route at 15, 30, 45, 60, 90, 120 min intervals.
// Results are cached in SQLite for 10 min, keyed by place ID pair + offset, so
// concurrent users asking the same route share one set of probe results instead
// of each triggering 6 API calls. Only uncached offsets hit the network.
// Returns the earliest offset (in minutes) where the drive falls under targetMin,
// or null if traffic stays heavy throughout the 2-hour window.
async function findClearTime(origin, destination, targetMin) {
  const offsets = [15, 30, 45, 60, 90, 120];
  const canCache = !!(origin.placeId && destination.placeId);

  // Resolve as many offsets as possible from cache before touching the API.
  const minutes = {};
  const toFetch = [];

  if (canCache) {
    for (const offset of offsets) {
      const cached = dbGetProbeCache(origin.placeId, destination.placeId, offset);
      if (cached !== null) {
        minutes[offset] = Math.round(cached / 60);
      } else {
        toFetch.push(offset);
      }
    }
  } else {
    toFetch.push(...offsets);
  }

  // Fire live calls only for offsets not covered by cache.
  if (toFetch.length > 0) {
    const results = await Promise.allSettled(
      toFetch.map(async (offset) => {
        const depTime = new Date(Date.now() + offset * 60_000);
        const result = await getDurationSeconds(origin, destination, depTime);
        const seconds = result?.seconds ?? null;
        if (canCache && seconds !== null) {
          dbSetProbeCache(origin.placeId, destination.placeId, offset, seconds);
        }
        return { offset, minutes: seconds !== null ? Math.round(seconds / 60) : Infinity };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') minutes[r.value.offset] = r.value.minutes;
    }
  }

  for (const offset of offsets) {
    if ((minutes[offset] ?? Infinity) <= targetMin) return offset;
  }
  return null;
}

async function handleDepartWithDeadline(
  bot, chatId, origin, destination, originStr, destinationStr,
  arriveByStr, current, baselineMin, baselineSource, dbId, mapsLink,
) {
  const arriveByDate = parseArriveBy(arriveByStr);
  const nowMs = Date.now();
  const minLeft = (arriveByDate.getTime() - nowMs) / 60_000;
  const deadlineStr = fmtTime(arriveByDate);
  const destShort = destinationStr.split(',')[0];

  if (minLeft <= 0) {
    await bot.sendMessage(chatId, `That deadline has already passed.`);
    return;
  }

  // Far-future deadline (> 4 h): current traffic is irrelevant; use a predictive probe instead.
  if (minLeft > FAR_FUTURE_MIN) {
    const staticMin = Math.round(current.staticSeconds / 60);
    const probeDepTime = new Date(arriveByDate.getTime() - Math.max(staticMin * 1.5, 45) * 60_000);
    let predicted;
    try {
      predicted = await getDurationSeconds(origin, destination, probeDepTime);
    } catch {
      predicted = null;
    }
    const predictedMin   = predicted ? Math.round(predicted.seconds / 60) : staticMin;
    const latestDep      = new Date(arriveByDate.getTime() - (predictedMin + BUFFER_MIN) * 60_000);
    // Fire the check 15 min before the calculated latest departure so the user gets
    // a timely nudge with live traffic, not a generic alert 2 h early.
    const watchStartsAt  = Math.floor(latestDep.getTime() / 1000) - 15 * 60;
    const watchThreshold = Math.ceil(predictedMin * ACCEPTABLE_RATIO);
    const checkTimeStr   = fmtTime(new Date(watchStartsAt * 1000));
    const arriveAtSec    = Math.floor(arriveByDate.getTime() / 1000);
    const pendingId = dbInsertPendingIntent(
      dbId, chatId, 'scheduled_watch',
      originStr, destinationStr, watchThreshold, watchStartsAt, arriveAtSec,
      origin.placeId, destination.placeId,
    );
    scheduleTimedWatch(bot, {
      id: pendingId, chat_id: chatId,
      origin: originStr, destination: destinationStr,
      threshold_min: watchThreshold, fire_at: watchStartsAt, arrive_at_sec: arriveAtSec,
      origin_place_id: origin.placeId ?? null, dest_place_id: destination.placeId ?? null,
    });
    await bot.sendMessage(
      chatId,
      `At ${fmtTime(probeDepTime)}, this route is predicted to take about ${predictedMin} min — ` +
      `plan to leave by ${fmtTime(latestDep)} to arrive before ${deadlineStr}.\n` +
      `(Forecast based on typical traffic patterns; I'll check again at ${checkTimeStr} and ping you with a live update.)\n${mapsLink}`
    );
    return;
  }

  // Near-future deadline: use current traffic.
  const currentMin = Math.round(current.seconds / 60);
  const diff = currentMin - baselineMin;
  const slackNow = minLeft - currentMin;

  // Can't make it even leaving right now.
  if (slackNow <= 0) {
    await bot.sendMessage(
      chatId,
      `You won't make it by ${deadlineStr} — ` +
      `${destShort} is ${currentMin} min away but you only have ${Math.floor(minLeft)} min left.\n${mapsLink}`
    );
    return;
  }

  // Technically possible but barely — no room for parking or settling in.
  if (slackNow <= BUFFER_MIN) {
    const heavyCtx = diff >= 3 ? ` (${diff} min heavier than ${baselineSource})` : '';
    await bot.sendMessage(
      chatId,
      `Leave right now — ${destShort} is ${currentMin} min away${heavyCtx} ` +
      `and you only have ${Math.floor(minLeft)} min until ${deadlineStr}. No buffer for parking.\n${mapsLink}`
    );
    return;
  }

  // Comfortable: enough slack to recommend a "leave by" time with buffer baked in.
  const latestDep = new Date(arriveByDate.getTime() - (currentMin + BUFFER_MIN) * 60_000);
  const minUntilLatest = Math.round((latestDep.getTime() - nowMs) / 60_000);
  const trafficCtx = diff <= -3
    ? ` — ${Math.abs(diff)} min faster than ${baselineSource}`
    : diff >= 3
    ? ` — ${diff} min slower than ${baselineSource}`
    : '';

  // Traffic is notably heavy: give departure time but also set a watch.
  if (diff > 5) {
    const watchThreshold = Math.max(Math.ceil(minLeft - BUFFER_MIN - 5), 1);
    await bot.sendMessage(
      chatId,
      `🟡 Leave by ${fmtTime(latestDep)} — ${minUntilLatest} min from now. ` +
      `Traffic is heavy right now (${currentMin} min${trafficCtx}); ` +
      `don't wait much longer or you'll risk missing ${deadlineStr}. ` +
      `I'll alert you if it drops to under ${watchThreshold} min.\n${mapsLink}`
    );
    commitWatch(chatId, originStr, destinationStr, watchThreshold, origin.placeId, destination.placeId);
    return;
  }

  // Normal or light traffic — schedule a live check 15 min before departure.
  const watchThreshold = Math.ceil(baselineMin * ACCEPTABLE_RATIO);
  const arriveAtSec    = Math.floor(arriveByDate.getTime() / 1000);
  const checkAt        = Math.floor(latestDep.getTime() / 1000) - 15 * 60;
  const hasTimeForCheck = checkAt > Math.floor(Date.now() / 1000) + 60;

  let checkTimeNote = '';
  if (hasTimeForCheck) {
    const pendingId = dbInsertPendingIntent(
      dbId, chatId, 'scheduled_watch',
      originStr, destinationStr, watchThreshold, checkAt, arriveAtSec,
      origin.placeId, destination.placeId,
    );
    scheduleTimedWatch(bot, {
      id: pendingId, chat_id: chatId,
      origin: originStr, destination: destinationStr,
      threshold_min: watchThreshold, fire_at: checkAt, arrive_at_sec: arriveAtSec,
      origin_place_id: origin.placeId ?? null, dest_place_id: destination.placeId ?? null,
    });
    checkTimeNote = `\n(I'll check again at ${fmtTime(new Date(checkAt * 1000))} and ping you with a live update.)`;
  }

  await bot.sendMessage(
    chatId,
    `🟢 Leave by ${fmtTime(latestDep)} — ${minUntilLatest} min from now. ` +
    `Drive is ${currentMin} min${trafficCtx}, ` +
    `so you'll arrive just before ${deadlineStr} with time to park and settle in.${checkTimeNote}\n${mapsLink}`
  );
}
