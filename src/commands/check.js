import { getRouteOptions } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { dbLogTraffic, dbGetPersonalTypical, dbLogDeparture } from '../db.js';
import { getNairobiComponents } from '../utils/time.js';

function congestionLabel(ratio) {
  if (ratio >= 1.4)  return 'heavy';
  if (ratio >= 1.15) return 'moderate';
  return 'clear';
}

// userId: the individual user's id (differs from chatId when called from a group).
// Used for personal traffic history and baselines. Defaults to chatId for private chats.
export async function handleCheck(bot, chatId, originStr, destinationStr, userId = null) {
  const dbId = userId ?? chatId;

  let origin, destination;
  try {
    [origin, destination] = await Promise.all([geocode(originStr), geocode(destinationStr)]);
  } catch (err) {
    if (err instanceof GeocodeNotFoundError) {
      await bot.sendMessage(chatId, err.message);
    } else {
      console.error('Geocoding error:', err.message);
      await bot.sendMessage(chatId, 'Something went wrong looking up those places. Try again in a moment.');
    }
    return;
  }

  let routes;
  try {
    routes = await getRouteOptions(origin, destination);
  } catch (err) {
    console.error('Traffic check error:', err.message);
    await bot.sendMessage(chatId, 'Could not fetch traffic right now. Try again in a moment.');
    return;
  }

  if (!routes?.length) {
    await bot.sendMessage(chatId, `No route found between ${originStr} and ${destinationStr}.`);
    return;
  }

  const primary = routes[0];
  dbLogTraffic(dbId, origin.formatted, destination.formatted, primary.seconds, primary.staticSeconds);
  dbLogDeparture(dbId, origin.formatted, destination.formatted);

  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents();
  const personal = dbGetPersonalTypical(dbId, origin.formatted, destination.formatted, dayOfWeek, hourOfDay);

  const originShort = originStr.split(',')[0];
  const destShort   = destinationStr.split(',')[0];
  const mapsLink    = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&travelmode=driving`;

  if (routes.length === 1) {
    const minutes    = Math.round(primary.seconds / 60);
    const typicalMin = Math.round(primary.staticSeconds / 60);
    const diff       = minutes - typicalMin;
    const trafficCtx = diff <= -3 ? ` — ${Math.abs(diff)} min faster than usual`
      : diff >= 3 ? ` — ${diff} min slower than usual`
      : ` — about normal`;

    let message = `${originShort} → ${destShort} is ${minutes} min right now${trafficCtx}.`;
    if (personal) {
      const pd = minutes - personal.avgMin;
      const pc = pd <= -3 ? `${Math.abs(pd)} min faster than`
        : pd >= 3 ? `${pd} min slower than`
        : 'about the same as';
      message += `\nYour typical ${dayName} ${hourStr}: ${personal.avgMin} min — ${pc} your usual (${personal.count} trips).`;
    }
    message += `\n${mapsLink}`;
    await bot.sendMessage(chatId, message);
    return;
  }

  // Multiple routes — build comparison table.
  // Each entry: label, current minutes, usual minutes, congestion condition.
  const options = routes.map((r, i) => {
    const min      = Math.round(r.seconds / 60);
    const statMin  = Math.round(r.staticSeconds / 60);
    const ratio    = r.seconds / r.staticSeconds;
    const cond     = congestionLabel(ratio);
    // Google returns a description like "via Uhuru Highway" when routes differ meaningfully.
    const label    = r.description ? `Via ${r.description}` : i === 0 ? 'Direct' : `Option ${i + 1}`;
    return { min, statMin, cond, label };
  });

  const fastest = options.reduce((a, b) => a.min < b.min ? a : b);
  const saving  = options[0].min - fastest.min;

  let message = `${originShort} → ${destShort} right now:\n`;
  for (const o of options) {
    message += `• ${o.label}: ${o.min} min (usually ${o.statMin} min) — ${o.cond}\n`;
  }

  if (saving >= 3) {
    message += `\nTake ${fastest.label} — saves ${saving} min today.`;
  } else {
    message += `\nDirect route is your best option right now.`;
  }

  if (personal) {
    const pd = options[0].min - personal.avgMin;
    const pc = pd <= -3 ? `${Math.abs(pd)} min faster than`
      : pd >= 3 ? `${pd} min slower than`
      : 'about the same as';
    message += `\nYour typical ${dayName} ${hourStr}: ${personal.avgMin} min — ${pc} your usual (${personal.count} trips).`;
  }

  message += `\n${mapsLink}`;
  await bot.sendMessage(chatId, message);
}
