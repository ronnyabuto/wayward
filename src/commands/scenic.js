import { getAlternativeRoutes, scoreAndRank, extractWaypoints, buildMapsLink } from '../services/scenic.js';
import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';

// Core logic — shared by the explicit /scenic command and the NLP path in bot.js.
export async function handleScenic(bot, chatId, originStr, destinationStr) {
  if (originStr.toLowerCase() === destinationStr.toLowerCase()) {
    await bot.sendMessage(chatId, 'Origin and destination must be different places.');
    return;
  }

  await bot.sendMessage(chatId, `🗺️ Finding scenic routes from ${originStr} to ${destinationStr}…`);

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
    routes = await getAlternativeRoutes(origin, destination);
  } catch (err) {
    console.error('ORS error:', err.message);
    if (err.orsCode === 2010) {
      await bot.sendMessage(chatId, "I couldn't find a drivable road near one of those locations. Try a nearby street or landmark instead.");
    } else if (err.orsCode === 2004) {
      await bot.sendMessage(chatId, 'Those locations are too far apart for scenic routing (over 100 km). Try two places closer together.');
    } else {
      await bot.sendMessage(chatId, 'Something went wrong fetching routes. Try again in a moment.');
    }
    return;
  }

  if (!routes.length) {
    await bot.sendMessage(chatId, 'No routes found between those locations.');
    return;
  }

  let best;
  try {
    best = await scoreAndRank(routes);
  } catch (err) {
    console.error('Scoring error:', err.message);
    await bot.sendMessage(chatId, 'Something went wrong scoring routes. Try again in a moment.');
    return;
  }

  if (!best) {
    await bot.sendMessage(chatId, 'Could not determine a scenic route. Try again in a moment.');
    return;
  }

  const baseDuration = Math.round(routes[0].summary.duration / 60);
  const bestDuration = Math.round(best.route.summary.duration / 60);
  const extraMin = bestDuration - baseDuration;
  const extraStr = extraMin > 0 ? `+${extraMin} min` : 'same time';

  const waypoints = extractWaypoints(best.coords, 3);
  const mapsLink = buildMapsLink(origin.formatted, destination.formatted, waypoints);

  const nearText = best.topName ? ` Passes near ${best.topName}.` : '';
  await bot.sendMessage(chatId, `🌿 Scenic route found (${extraStr}).${nearText}\n${mapsLink}`);
}

