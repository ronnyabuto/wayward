import { getDurationSeconds, getTypicalDuration } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { commitWatch } from './watch.js';
import { dbLogTraffic, dbGetPersonalTypical, dbLogTrafficPool, dbGetPoolTypical, dbInsertPendingIntent, dbGetProbeCache, dbSetProbeCache } from '../db.js';
import { scheduleTimedWatch } from '../scheduler.js';
import { getNairobiComponents, fmtTime } from '../utils/time.js';
import { planDeparture, MIN_WORTHWHILE_SAVING_MIN } from '../utils/departurePlan.js';
import { logger } from '../utils/logger.js';

const ACCEPTABLE_RATIO = 1.2;
const BUFFER_MIN = 8;       // minutes subtracted from latest departure as a parking/settling buffer
const FAR_FUTURE_MIN = 240; // deadlines > 4 h away use predictive traffic, not current

// Parse an NLP-produced "HH:MM" (Nairobi local 24 h) into a UTC Date.
// If the resulting moment is already in the past, adds 24 h (tomorrow).
// Used for both arrive_by (arrival deadlines) and depart_after (departure-
// window start times) — same "next upcoming occurrence" semantics either way.
function parseTimeHHMM(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no DST
  const nowMs = Date.now();
  const nairobiMs = nowMs + NAIROBI_OFFSET_MS;
  const midnightMs = nairobiMs - (nairobiMs % 86_400_000);
  const targetMs = midnightMs + (h * 60 + m) * 60_000 - NAIROBI_OFFSET_MS;
  return new Date(targetMs <= nowMs ? targetMs + 86_400_000 : targetMs);
}

// explicitThreshold only applies with departAfter: a watch with a start time
// ("start watching at 9pm, tell me when it's under 40") keeps the user's own
// number instead of the baseline-derived one.
export async function handleDepart(bot, chatId, originStr, destinationStr, arriveBy = null, userId = null, departAfter = null, explicitThreshold = null) {
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

  // Deferred departure window: the user isn't ready now and gave a future
  // start time ("any time from 4pm") instead of an arrival deadline. Checking
  // current traffic here would answer a question they didn't ask, and would
  // contradict an explicit "not yet" — schedule the check for departAfter
  // instead, reusing the same scheduled_watch mechanism the far-future
  // arrive_by path below already relies on.
  if (!arriveBy && departAfter) {
    await handleDepartAfter(bot, chatId, origin, destination, originStr, destinationStr, departAfter, dbId, explicitThreshold);
    return;
  }

  let current, usual;
  try {
    [current, usual] = await Promise.all([
      getDurationSeconds(origin, destination),
      usualAt(origin, destination, new Date(), dbId),
    ]);
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

  // The no-traffic time is only a last resort, when Google's typical-traffic
  // lookup failed but the live one didn't — and it's labelled for what it is.
  const baselineMin    = usual?.minutes ?? Math.round(current.staticSeconds / 60);
  const baselineSource = usual?.label ?? 'the no-traffic time';
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

  // Slower than usual — state by how much instead of labelling it "heavy",
  // and let the forecast decide whether waiting actually helps.
  const plan = planDeparture(currentMin, threshold, await forecastDurations(origin, destination));
  const at = (offset) => fmtTime(new Date(Date.now() + offset * 60_000));
  const now = `🟡 ${originShort} → ${destShort} is ${currentMin} min right now — ` +
    `${currentMin - baselineMin} min slower than ${baselineSource} (${baselineMin} min).`;

  // Silently create the watch where one is needed — no extra confirmation,
  // the reply already says it. A flat forecast gets none: there is no better
  // time coming to alert about.
  if (plan.kind === 'clears') {
    await bot.sendMessage(
      chatId,
      `${now}\nIt should ease around ${at(plan.offset)} (about ${plan.minutes} min) — find something to do for about ${plan.offset} min. I'll message you when the drive drops under ${threshold} min.\n${mapsLink}`
    );
    commitWatch(chatId, originStr, destinationStr, threshold, origin.placeId, destination.placeId);
  } else if (plan.kind === 'improves') {
    await bot.sendMessage(
      chatId,
      `${now}\nBest time in the next 2 hours is around ${at(plan.offset)} — about ${plan.minutes} min. I'll message you when the drive drops under ${plan.watchThreshold} min.\n${mapsLink}`
    );
    commitWatch(chatId, originStr, destinationStr, plan.watchThreshold, origin.placeId, destination.placeId);
  } else if (plan.kind === 'flat') {
    const range = plan.low === plan.high ? `${plan.low} min` : `${plan.low}–${plan.high} min`;
    await bot.sendMessage(
      chatId,
      `${now}\nWaiting won't help — it stays around ${range} for the next 2 hours. Leave when you're ready.\n${mapsLink}`
    );
  } else {
    const watchThreshold = currentMin - MIN_WORTHWHILE_SAVING_MIN;
    await bot.sendMessage(
      chatId,
      `${now}\nI couldn't get a forecast for this route right now. I'll keep watching and message you when the drive drops under ${watchThreshold} min.\n${mapsLink}`
    );
    commitWatch(chatId, originStr, destinationStr, watchThreshold, origin.placeId, destination.placeId);
  }
}

// The usual drive for this route at the weekday and hour of `at`, most
// specific source first: this user's own trips, then everyone's trips on the
// same place pair, then Google's historical model. Returns { minutes, label }
// with label phrased to follow "slower than" / "about", or null if Google's
// lookup fails and there's no trip history.
async function usualAt(origin, destination, at, dbId) {
  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents(at);
  const personal = dbGetPersonalTypical(dbId, origin.formatted, destination.formatted, dayOfWeek, hourOfDay);
  if (personal) return { minutes: personal.avgMin, label: `your usual ${dayName} ${hourStr}` };

  const pool = origin.placeId && destination.placeId
    ? dbGetPoolTypical(origin.placeId, destination.placeId, dayOfWeek, hourOfDay)
    : null;
  if (pool) return { minutes: pool.avgMin, label: `the community average for ${dayName} ${hourStr}` };

  try {
    const typical = await getTypicalDuration(origin, destination, at);
    if (typical) return { minutes: Math.round(typical.seconds / 60), label: `usual for ${dayName} ${hourStr}` };
  } catch (err) {
    logger.warn({ err }, 'typical-traffic lookup failed');
  }
  return null;
}

// "Ping me the best time to leave, any time from <departAfter>" — the user
// isn't ready yet, so there's no live traffic to evaluate. Schedules a single
// check at departAfter via the same pending_intents/scheduleTimedWatch
// mechanism the far-future arrive_by path uses (arrive_at_sec is simply null
// here — scheduleTimedWatch already handles that case, reporting the result
// without an arrival-time framing). If traffic is still bad at that check,
// scheduleTimedWatch falls back to a continuous watch until it clears — which
// is exactly "tell me when traffic is least".
async function handleDepartAfter(bot, chatId, origin, destination, originStr, destinationStr, departAfterStr, dbId, explicitThreshold = null) {
  const departAfterDate = parseTimeHHMM(departAfterStr);
  const originShort = originStr.split(',')[0];
  const destShort   = destinationStr.split(',')[0];
  const mapsLink    = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&travelmode=driving`;

  // Threshold from the usual at the hour the window opens, not the current
  // hour — traffic at 9pm isn't traffic at 3pm.
  let threshold = explicitThreshold;
  if (threshold === null) {
    const usual = await usualAt(origin, destination, departAfterDate, dbId);
    if (!usual) {
      await bot.sendMessage(chatId, 'Could not fetch traffic right now. Try again in a moment.');
      return;
    }
    threshold = Math.ceil(usual.minutes * ACCEPTABLE_RATIO);
  }
  const fireAtSec = Math.floor(departAfterDate.getTime() / 1000);

  const pendingId = dbInsertPendingIntent(
    dbId, chatId, 'scheduled_watch',
    originStr, destinationStr, threshold, fireAtSec, null,
    origin.placeId, destination.placeId,
  );
  scheduleTimedWatch(bot, {
    id: pendingId, chat_id: chatId,
    origin: originStr, destination: destinationStr,
    threshold_min: threshold, fire_at: fireAtSec, arrive_at_sec: null,
    origin_place_id: origin.placeId ?? null, dest_place_id: destination.placeId ?? null,
  });

  await bot.sendMessage(
    chatId,
    `Got it — I'll start watching ${originShort} → ${destShort} at ${fmtTime(departAfterDate)} and message you as soon as the drive is under ${threshold} min.\n${mapsLink}`
  );
}

// Query the route at 15, 30, 45, 60, 90, 120 min intervals.
// Results are cached in SQLite for 10 min, keyed by place ID pair + offset, so
// concurrent users asking the same route share one set of probe results instead
// of each triggering 6 API calls. Only uncached offsets hit the network.
// Returns [{ offset, minutes }] in offset order, omitting probes that failed.
async function forecastDurations(origin, destination) {
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
        return { offset, minutes: seconds !== null ? Math.round(seconds / 60) : null };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.minutes !== null) minutes[r.value.offset] = r.value.minutes;
    }
  }

  return offsets
    .filter(offset => minutes[offset] !== undefined)
    .map(offset => ({ offset, minutes: minutes[offset] }));
}

async function handleDepartWithDeadline(
  bot, chatId, origin, destination, originStr, destinationStr,
  arriveByStr, current, baselineMin, baselineSource, dbId, mapsLink,
) {
  const arriveByDate = parseTimeHHMM(arriveByStr);
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
    commitWatch(chatId, originStr, destinationStr, watchThreshold, origin.placeId, destination.placeId,
                Math.floor(arriveByDate.getTime() / 1000));
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
