import { getDurationSeconds } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { commitWatch } from './watch.js';
import { dbLogTraffic, dbGetPersonalTypical } from '../db.js';
import { getNairobiComponents } from '../utils/time.js';

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
  const midnightMs = nairobiMs - (nairobiMs % 86_400_000); // midnight Nairobi in shifted space
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
      console.error('Depart geocode error:', err.message);
      await bot.sendMessage(chatId, 'Something went wrong looking up those places. Try again in a moment.');
    }
    return;
  }

  const dbId = userId ?? chatId;

  let current;
  try {
    current = await getDurationSeconds(origin, destination);
  } catch (err) {
    console.error('Depart traffic error:', err.message);
    await bot.sendMessage(chatId, 'Could not fetch traffic right now. Try again in a moment.');
    return;
  }

  if (!current) {
    await bot.sendMessage(chatId, `No route found between ${originStr} and ${destinationStr}.`);
    return;
  }

  dbLogTraffic(dbId, origin.formatted, destination.formatted, current.seconds, current.staticSeconds);

  const currentMin = Math.round(current.seconds / 60);
  const typicalMin = Math.round(current.staticSeconds / 60);

  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents();
  const personal   = dbGetPersonalTypical(dbId, origin.formatted, destination.formatted, dayOfWeek, hourOfDay);
  const baselineMin = personal ? personal.avgMin : typicalMin;
  const threshold   = Math.ceil(baselineMin * ACCEPTABLE_RATIO);

  const originShort = originStr.split(',')[0];
  const destShort   = destinationStr.split(',')[0];
  const mapsLink    = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&travelmode=driving`;

  if (arriveBy) {
    await handleDepartWithDeadline(
      bot, chatId, origin, destination, originStr, destinationStr,
      arriveBy, current, baselineMin, dbId, mapsLink,
    );
    return;
  }

  // Traffic is already acceptable — go now
  if (currentMin <= threshold) {
    const diff = currentMin - baselineMin;
    const context = diff < -2
      ? ` — ${Math.abs(diff)} min faster than ${personal ? `your usual ${dayName} ${hourStr}` : 'usual'}`
      : diff > 2
      ? ` — ${diff} min slower than ${personal ? `your usual ${dayName} ${hourStr}` : 'usual'}`
      : ` — about ${personal ? `your usual ${dayName} ${hourStr}` : 'normal'}`;
    await bot.sendMessage(
      chatId,
      `🟢 Good time to head out — ${originShort} → ${destShort} is ${currentMin} min right now${context}. Leave when you're ready.\n${mapsLink}`
    );
    return;
  }

  // Traffic is heavy — find when it clears
  const baselineLabel = personal
    ? `your usual ${dayName} ${hourStr} is ${baselineMin} min`
    : `usually ${typicalMin} min`;
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

  // Silently create the watch — no extra confirmation message, we already told the user above.
  commitWatch(chatId, originStr, destinationStr, threshold);
}

// Query the route at 15, 30, 45, 60, 90, 120 min intervals in parallel.
// Returns the earliest offset (in minutes) where the drive falls under targetMin,
// or null if traffic stays heavy throughout the 2-hour window.
async function findClearTime(origin, destination, targetMin) {
  const offsets = [15, 30, 45, 60, 90, 120];

  const results = await Promise.allSettled(
    offsets.map(async (offset) => {
      const depTime = new Date(Date.now() + offset * 60_000);
      const result = await getDurationSeconds(origin, destination, depTime);
      return { offset, minutes: result ? Math.round(result.seconds / 60) : Infinity };
    })
  );

  for (const offset of offsets) {
    const match = results.find(
      (r) => r.status === 'fulfilled' && r.value.offset === offset
    );
    if (match && match.value.minutes <= targetMin) return offset;
  }
  return null;
}

async function handleDepartWithDeadline(
  bot, chatId, origin, destination, originStr, destinationStr,
  arriveByStr, current, baselineMin, dbId, mapsLink,
) {
  const arriveByDate = parseArriveBy(arriveByStr);
  const nowMs = Date.now();
  const minLeft = (arriveByDate.getTime() - nowMs) / 60_000;
  const deadlineStr = fmtTime(arriveByDate);
  const destShort = destinationStr.split(',')[0];

  // Deadline already passed (shouldn't happen if NLP resolved AM/PM correctly, but guard it).
  if (minLeft <= 0) {
    await bot.sendMessage(chatId, `That deadline has already passed.`);
    return;
  }

  // Far-future deadline (> 4 h): current traffic is irrelevant; use a predictive probe instead.
  if (minLeft > FAR_FUTURE_MIN) {
    const staticMin = Math.round(current.staticSeconds / 60);
    // Probe at (staticMin × 1.5) before the deadline as a safe estimate of departure time.
    const probeDepTime = new Date(arriveByDate.getTime() - Math.max(staticMin * 1.5, 45) * 60_000);
    let predicted;
    try {
      predicted = await getDurationSeconds(origin, destination, probeDepTime);
    } catch {
      predicted = null;
    }
    const predictedMin = predicted ? Math.round(predicted.seconds / 60) : staticMin;
    const latestDep = new Date(arriveByDate.getTime() - (predictedMin + BUFFER_MIN) * 60_000);
    await bot.sendMessage(
      chatId,
      `At ${fmtTime(probeDepTime)}, this route is predicted to take about ${predictedMin} min — ` +
      `plan to leave by ${fmtTime(latestDep)} to arrive before ${deadlineStr}.\n` +
      `(Forecast based on typical traffic patterns; check again closer to the time.)\n${mapsLink}`
    );
    return;
  }

  // Near-future deadline: use current traffic.
  const currentMin = Math.round(current.seconds / 60);
  const diff = currentMin - baselineMin;
  const slackNow = minLeft - currentMin; // buffer remaining if leaving right now

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
    const heavyCtx = diff >= 3 ? ` (${diff} min heavier than usual)` : '';
    await bot.sendMessage(
      chatId,
      `Leave right now — ${destShort} is ${currentMin} min away${heavyCtx} ` +
      `and you only have ${Math.floor(minLeft)} min until ${deadlineStr}. No buffer for parking.\n${mapsLink}`
    );
    return;
  }

  // Comfortable: enough slack to recommend a "leave by" time with buffer baked in.
  // latestDep = latest moment where you still arrive (currentMin + BUFFER_MIN) before deadline.
  const latestDep = new Date(arriveByDate.getTime() - (currentMin + BUFFER_MIN) * 60_000);
  const minUntilLatest = Math.round((latestDep.getTime() - nowMs) / 60_000);
  const trafficCtx = diff <= -3
    ? ` — ${Math.abs(diff)} min faster than usual`
    : diff >= 3
    ? ` — ${diff} min slower than usual`
    : '';

  // Traffic is notably heavy: give the departure time based on current conditions,
  // but also set a watch so the user is alerted if it eases (giving them more buffer).
  if (diff > 5) {
    // Watch threshold: max travel time that still gets them there in time.
    // Slightly conservative (−5 min) to account for time that may pass before the watch fires.
    const watchThreshold = Math.max(Math.ceil(minLeft - BUFFER_MIN - 5), 1);
    await bot.sendMessage(
      chatId,
      `🟡 Leave by ${fmtTime(latestDep)} — ${minUntilLatest} min from now. ` +
      `Traffic is heavy right now (${currentMin} min${trafficCtx}); ` +
      `don't wait much longer or you'll risk missing ${deadlineStr}. ` +
      `I'll alert you if it drops to under ${watchThreshold} min.\n${mapsLink}`
    );
    commitWatch(chatId, originStr, destinationStr, watchThreshold);
    return;
  }

  // Normal or light traffic.
  await bot.sendMessage(
    chatId,
    `🟢 Leave by ${fmtTime(latestDep)} — ${minUntilLatest} min from now. ` +
    `Drive is ${currentMin} min${trafficCtx}, ` +
    `so you'll arrive just before ${deadlineStr} with time to park and settle in.\n${mapsLink}`
  );
}
