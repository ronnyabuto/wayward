import { getRouteOptions } from '../services/traffic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';

// Matatu road condition labels derived from car traffic congestion ratios.
// Framed as what a matatu passenger would experience, not a driver.
function matatuCondition(ratio) {
  if (ratio >= 1.6) return { emoji: '🔴', label: 'very slow', advice: 'heavy road congestion — long waits at stages and slow progress' };
  if (ratio >= 1.3) return { emoji: '🟡', label: 'slow',      advice: 'moderate congestion — matatus are moving but not freely' };
  return               { emoji: '🟢', label: 'moving',    advice: 'road is clear — matatus should be running well' };
}

// handleMatatu uses car traffic on the origin→destination corridor as a proxy
// for matatu conditions. No real-time matatu API exists publicly for Nairobi
// (NTSA GPS data is not open), so road congestion is the best available signal.
// This is explicitly framed in responses so users know what the data represents.
export async function handleMatatu(bot, chatId, originStr, destinationStr) {
  let origin, destination;
  try {
    [origin, destination] = await Promise.all([geocode(originStr), geocode(destinationStr)]);
  } catch (err) {
    if (err instanceof GeocodeNotFoundError) {
      await bot.sendMessage(chatId, err.message);
    } else {
      console.error('Matatu geocode error:', err.message);
      await bot.sendMessage(chatId, 'Something went wrong looking up those places. Try again in a moment.');
    }
    return;
  }

  let routes;
  try {
    routes = await getRouteOptions(origin, destination);
  } catch (err) {
    console.error('Matatu traffic error:', err.message);
    await bot.sendMessage(chatId, 'Could not fetch road conditions right now. Try again in a moment.');
    return;
  }

  if (!routes?.length) {
    await bot.sendMessage(chatId, `No route found between ${originStr} and ${destinationStr}.`);
    return;
  }

  const primary  = routes[0];
  const ratio    = primary.seconds / primary.staticSeconds;
  const { emoji, label, advice } = matatuCondition(ratio);
  const curMin   = Math.round(primary.seconds / 60);
  const statMin  = Math.round(primary.staticSeconds / 60);

  const originShort = originStr.split(',')[0];
  const destShort   = destinationStr.split(',')[0];

  let message = `${emoji} Matatu corridor ${originShort} → ${destShort}: ${label}\n`;
  message += `Road traffic: ${curMin} min right now (usually ${statMin} min) — ${advice}.`;

  // If there's an alternative route that's notably less congested, surface it.
  if (routes.length > 1) {
    const alt      = routes[1];
    const altRatio = alt.seconds / alt.staticSeconds;
    const altMin   = Math.round(alt.seconds / 60);
    if (altRatio < ratio - 0.15 && altMin < curMin) {
      const altLabel = alt.description ? `Via ${alt.description}` : 'An alternative route';
      message += `\n${altLabel} is less congested (${altMin} min) — if your matatu has a stage on that road, it may be quicker.`;
    }
  }

  message += `\n\n_Based on road traffic conditions. No live matatu tracking is available for Nairobi._`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}
