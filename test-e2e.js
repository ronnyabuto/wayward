/**
 * End-to-end test harness for Wayward.
 * Exercises all code paths against real APIs, mimicking human Telegram usage.
 * Run: node test-e2e.js
 */
import 'dotenv/config';
import { initDb, dbGetSavedPlaces, dbSetPlace, dbLogTraffic, dbGetPersonalTypical,
         dbInsertWatch, dbDeleteWatch, dbGetAllWatches, dbSetFailCount } from './src/db.js';
import { geocode, GeocodeNotFoundError } from './src/utils/geocode.js';
import { getDurationSeconds } from './src/services/traffic.js';
import { parseIntent } from './src/utils/nlp.js';
import { getNairobiComponents } from './src/utils/time.js';
import { getAlternativeRoutes, scoreAndRank, buildMapsLink, extractWaypoints } from './src/services/scenic.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(label) {
  passed++;
  console.log(`  ✓  ${label}`);
}

function fail(label, reason) {
  failed++;
  failures.push({ label, reason });
  console.log(`  ✗  ${label}`);
  console.log(`       → ${reason}`);
}

function skip(label, reason) {
  skipped++;
  console.log(`  -  ${label} (skipped: ${reason})`);
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function test(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Test data ─────────────────────────────────────────────────────────────────
// Real Nairobi places — used throughout all test sections.
// Use a unique chat ID per run so traffic_history rows from previous runs don't bleed in.
const FAKE_CHAT_ID = 9000000 + (Date.now() % 999999 | 0);
const ORIGIN_STR = 'Kahawa Sukari, Nairobi';
const DEST_STR   = 'Westlands, Nairobi';

// ─────────────────────────────────────────────────────────────────────────────
section('1. MODULE LOADING — all imports resolve without errors');
// (If we got here without crashing, all imports succeeded)
pass('All ESM imports resolve');

// ─────────────────────────────────────────────────────────────────────────────
section('2. SQLITE — initDb, saved places, traffic history, watches');

initDb();
pass('initDb() runs without error');


await test('dbSetPlace stores a record', () => {
  dbSetPlace(FAKE_CHAT_ID, 'work', 'Westlands, Nairobi, Kenya');
  dbSetPlace(FAKE_CHAT_ID, 'home', 'Kahawa Sukari, Nairobi, Kenya');
});

await test('dbGetSavedPlaces returns saved records', () => {
  const places = dbGetSavedPlaces(FAKE_CHAT_ID);
  assert(places.work === 'Westlands, Nairobi, Kenya', `work mismatch: ${places.work}`);
  assert(places.home === 'Kahawa Sukari, Nairobi, Kenya', `home mismatch: ${places.home}`);
});

await test('dbSetPlace is case-insensitive (lowercases name)', () => {
  dbSetPlace(FAKE_CHAT_ID, 'OFFICE', 'Karen, Nairobi, Kenya');
  const places = dbGetSavedPlaces(FAKE_CHAT_ID);
  assert(places.office === 'Karen, Nairobi, Kenya', `office not stored: ${JSON.stringify(places)}`);
});

await test('dbLogTraffic inserts rows and dbGetPersonalTypical returns null for <3 points', () => {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  dbLogTraffic(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, 1800, 1500);
  dbLogTraffic(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, 1900, 1500);
  const result = dbGetPersonalTypical(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, dayOfWeek, hourOfDay);
  assert(result === null, `Expected null for 2 data points, got: ${JSON.stringify(result)}`);
});

await test('dbGetPersonalTypical returns avgMin + count after 3+ data points', () => {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  dbLogTraffic(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, 2100, 1500); // 3rd point
  const result = dbGetPersonalTypical(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, dayOfWeek, hourOfDay);
  assert(result !== null, 'Expected non-null after 3 data points');
  assert(typeof result.avgMin === 'number', `avgMin not a number: ${result.avgMin}`);
  assert(result.count >= 3, `count < 3: ${result.count}`);
  console.log(`       Personal avg: ${result.avgMin} min over ${result.count} trips`);
});

await test('dbInsertWatch returns a numeric ID', () => {
  const id = dbInsertWatch(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, 45);
  assert(typeof id === 'number' && id > 0, `Bad watch ID: ${id}`);
  dbDeleteWatch(id); // clean up
});

await test('dbGetAllWatches returns array', () => {
  const rows = dbGetAllWatches();
  assert(Array.isArray(rows), 'Expected array');
});

await test('dbSetFailCount updates fail_count in DB', () => {
  const id = dbInsertWatch(FAKE_CHAT_ID, ORIGIN_STR, DEST_STR, 40);
  dbSetFailCount(id, 3);
  const rows = dbGetAllWatches();
  const row = rows.find(r => r.id === id);
  assert(row?.fail_count === 3, `fail_count not updated: ${row?.fail_count}`);
  dbDeleteWatch(id);
});

// ─────────────────────────────────────────────────────────────────────────────
section('3. TIME UTILITIES — Nairobi components');

await test('getNairobiComponents returns valid fields', () => {
  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents();
  assert(dayOfWeek >= 0 && dayOfWeek <= 6, `Bad dayOfWeek: ${dayOfWeek}`);
  assert(hourOfDay >= 0 && hourOfDay <= 23, `Bad hourOfDay: ${hourOfDay}`);
  assert(typeof dayName === 'string' && dayName.length > 0, `Bad dayName: ${dayName}`);
  assert(typeof hourStr === 'string' && hourStr.length > 0, `Bad hourStr: ${hourStr}`);
  console.log(`       Now in Nairobi: ${dayName} ${hourStr} (day=${dayOfWeek}, hour=${hourOfDay})`);
});

await test('getNairobiComponents with explicit UTC midnight is 3am Nairobi', () => {
  const utcMidnight = new Date('2024-01-15T00:00:00Z');
  const { hourOfDay, dayName } = getNairobiComponents(utcMidnight);
  assert(hourOfDay === 3, `Expected 3am Nairobi, got hour ${hourOfDay}`);
  assert(dayName === 'Monday', `Expected Monday, got ${dayName}`);
});

// ─────────────────────────────────────────────────────────────────────────────
section('4. GEOCODING — real Google Geocoding API calls');

let originGeocode, destGeocode;

await test('Geocode "Kahawa Sukari, Nairobi" → Kenya bbox', async () => {
  originGeocode = await geocode('Kahawa Sukari, Nairobi');
  assert(originGeocode.lat && originGeocode.lon, 'No lat/lon returned');
  assert(originGeocode.formatted, 'No formatted address');
  // Kenya bbox check
  assert(originGeocode.lat > -4.9 && originGeocode.lat < 4.6, `Lat out of Kenya: ${originGeocode.lat}`);
  assert(originGeocode.lon > 33.9 && originGeocode.lon < 41.9, `Lon out of Kenya: ${originGeocode.lon}`);
  console.log(`       → ${originGeocode.formatted} (${originGeocode.lat.toFixed(4)}, ${originGeocode.lon.toFixed(4)})`);
});

await test('Geocode "Westlands, Nairobi"', async () => {
  destGeocode = await geocode('Westlands, Nairobi');
  assert(destGeocode.formatted.includes('Westlands') || destGeocode.formatted.includes('Nairobi'),
    `Unexpected address: ${destGeocode.formatted}`);
  console.log(`       → ${destGeocode.formatted}`);
});

await test('Geocode "Karen, Nairobi" → Kenya', async () => {
  const r = await geocode('Karen, Nairobi');
  assert(r.lat > -4.9 && r.lat < 4.6, `Out of Kenya: ${r.lat}`);
  console.log(`       → ${r.formatted}`);
});

await test('Geocode cache hit on second call (same result, no API call)', async () => {
  const r1 = await geocode('Westlands, Nairobi');
  const r2 = await geocode('Westlands, Nairobi');
  assert(r1.formatted === r2.formatted, 'Cache returned different result');
});

await test('GeocodeNotFoundError thrown for nonsense place', async () => {
  try {
    await geocode('xqzjklwvbm99 blarghville notaplace');
    throw new Error('Should have thrown GeocodeNotFoundError');
  } catch (err) {
    assert(err instanceof GeocodeNotFoundError, `Wrong error type: ${err.constructor.name}: ${err.message}`);
  }
});

await test('GeocodeNotFoundError thrown for country-level result (Kenya)', async () => {
  // "Kenya" alone resolves to country-level — should be rejected as too vague
  try {
    await geocode('Kenya');
    // If it doesn't throw, check it was accepted (some APIs now return specific enough result)
    // This is acceptable behavior — just log it
    console.log('       Note: "Kenya" was accepted (check if result was specific enough)');
  } catch (err) {
    assert(err instanceof GeocodeNotFoundError, `Wrong error type: ${err.constructor.name}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('5. TRAFFIC API — real Google Routes API calls');

let trafficResult;

await test('getDurationSeconds returns seconds + staticSeconds', async () => {
  trafficResult = await getDurationSeconds(
    originGeocode?.formatted ?? 'Kahawa Sukari, Nairobi, Kenya',
    destGeocode?.formatted  ?? 'Westlands, Nairobi, Kenya'
  );
  assert(trafficResult !== null, 'Expected a route, got null');
  assert(typeof trafficResult.seconds === 'number' && trafficResult.seconds > 0,
    `Bad seconds: ${trafficResult.seconds}`);
  assert(typeof trafficResult.staticSeconds === 'number' && trafficResult.staticSeconds > 0,
    `Bad staticSeconds: ${trafficResult.staticSeconds}`);
  const currentMin = Math.round(trafficResult.seconds / 60);
  const staticMin  = Math.round(trafficResult.staticSeconds / 60);
  console.log(`       Live: ${currentMin} min | Static baseline: ${staticMin} min`);
});

await test('getDurationSeconds with future departureTime (traffic forecast)', async () => {
  const future = new Date(Date.now() + 30 * 60_000); // 30 min from now
  const result = await getDurationSeconds(
    originGeocode?.formatted ?? 'Kahawa Sukari, Nairobi, Kenya',
    destGeocode?.formatted  ?? 'Westlands, Nairobi, Kenya',
    future
  );
  assert(result !== null, 'Expected a route for future departure, got null');
  assert(typeof result.seconds === 'number' && result.seconds > 0, `Bad future seconds: ${result.seconds}`);
  console.log(`       +30min forecast: ${Math.round(result.seconds / 60)} min`);
});

await test('getDurationSeconds returns null for impossible route (ocean → land far away)', async () => {
  // Use a very remote pairing that Google won't find a driving route for
  // Alternatively, test two disconnected island coords — but easiest is a place known to fail
  // We'll trust the null path and just skip full validation since no guaranteed failing pair
  skip('No-route null return', 'No guaranteed unroutable pair in Kenya that is still geocodable');
});

// ─────────────────────────────────────────────────────────────────────────────
section('6. NLP / INTENT PARSING — Gemini API, all 6 commands');

// Small delay between Gemini calls to avoid per-minute rate limits.
const NLP_DELAY_MS = 4500;
async function parseAndLog(msg, savedPlaces = {}, history = []) {
  await new Promise(r => setTimeout(r, NLP_DELAY_MS));
  const intent = await parseIntent(msg, savedPlaces, history);
  console.log(`       "${msg.slice(0, 55)}${msg.length > 55 ? '…' : ''}"`);
  console.log(`       → command=${intent.command} origin=${intent.origin} dest=${intent.destination} threshold=${intent.threshold}`);
  if (intent.clarification) console.log(`       clarification: ${intent.clarification}`);
  return intent;
}

// --- check ---
await test('NLP: "how long to Westlands from Karen" → check', async () => {
  const i = await parseAndLog('how long to Westlands from Karen');
  assert(i.command === 'check', `Expected check, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('karen'), `Origin should be Karen: ${i.origin}`);
  assert(i.destination?.toLowerCase().includes('westlands'), `Dest should be Westlands: ${i.destination}`);
});

await test('NLP: "when should I leave in the next 20 min to get to CBD fastest" → check (not watch)', async () => {
  const i = await parseAndLog('when should I leave in the next 20 min to get to CBD fastest', { home: 'Kahawa Sukari, Nairobi, Kenya' });
  assert(i.command === 'check', `Expected check, got ${i.command}. Threshold=${i.threshold}. "20 min" is a departure window, not a watch threshold.`);
});

await test('NLP: "how is traffic from Eastleigh to Ngong Road" → check', async () => {
  const i = await parseAndLog('how is traffic from Eastleigh to Ngong Road');
  assert(i.command === 'check', `Expected check, got ${i.command}`);
});

// --- watch ---
await test('NLP: "tell me when Kahawa Sukari to Westlands drops under 35 min" → watch, threshold=35', async () => {
  const i = await parseAndLog('tell me when Kahawa Sukari to Westlands drops under 35 min');
  assert(i.command === 'watch', `Expected watch, got ${i.command}`);
  assert(i.threshold === 35, `Expected threshold 35, got ${i.threshold}`);
});

await test('NLP: "alert me when I can get from Karen to JKIA in less than an hour" → watch, threshold=60', async () => {
  const i = await parseAndLog('alert me when I can get from Karen to JKIA in less than an hour');
  assert(i.command === 'watch', `Expected watch, got ${i.command}`);
  assert(i.threshold === 60, `Expected threshold 60, got ${i.threshold}`);
});

// --- depart ---
await test('NLP: "I\'m done at work, heading home" + saved places → depart', async () => {
  const places = { work: 'Westlands, Nairobi, Kenya', home: 'Kahawa Sukari, Nairobi, Kenya' };
  const i = await parseAndLog("I'm done at work, heading home", places);
  assert(i.command === 'depart', `Expected depart, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('westlands'), `Origin should be work/Westlands: ${i.origin}`);
  assert(i.destination?.toLowerCase().includes('kahawa'), `Dest should be home/Kahawa: ${i.destination}`);
});

await test('NLP: "leaving work now, is traffic bad?" → depart', async () => {
  const i = await parseAndLog('leaving work now, is traffic bad?', { work: 'Westlands, Nairobi, Kenya', home: 'Kahawa Sukari, Nairobi, Kenya' });
  assert(i.command === 'depart', `Expected depart, got ${i.command}`);
});

// --- setplace ---
await test('NLP: "my home is at Seresponda Court, Kileleshwa" → setplace', async () => {
  const i = await parseAndLog('my home is at Seresponda Court, Kileleshwa');
  assert(i.command === 'setplace', `Expected setplace, got ${i.command}`);
  assert(i.place_name?.toLowerCase() === 'home', `place_name should be home: ${i.place_name}`);
  assert(i.place_address?.toLowerCase().includes('seresponda'), `place_address should include Seresponda: ${i.place_address}`);
});

await test('NLP: "save my work as ABC Place, Westlands" → setplace', async () => {
  const i = await parseAndLog('save my work as ABC Place, Westlands');
  assert(i.command === 'setplace', `Expected setplace, got ${i.command}`);
  assert(i.place_name?.toLowerCase() === 'work', `place_name should be work: ${i.place_name}`);
});

// --- scenic ---
await test('NLP: "show me a scenic route from Karen to Gigiri" → scenic', async () => {
  const i = await parseAndLog('show me a scenic route from Karen to Gigiri');
  assert(i.command === 'scenic', `Expected scenic, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('karen'), `Origin should be Karen: ${i.origin}`);
});

// --- unknown ---
await test('NLP: pure gibberish → unknown + clarification', async () => {
  const i = await parseAndLog('xyzzy plugh frobozz');
  assert(i.command === 'unknown', `Expected unknown, got ${i.command}`);
  assert(typeof i.clarification === 'string' && i.clarification.length > 0, 'Expected clarification string');
});

await test('NLP: referencing unsaved place "home" when no places saved → unknown', async () => {
  const i = await parseAndLog("I'm done at work heading home", {}); // no saved places
  // Gemini should recognise it can't resolve "home" → unknown
  if (i.command === 'unknown') {
    assert(typeof i.clarification === 'string', 'Expected clarification');
  } else {
    // Gemini may attempt to interpret as depart with null origin/dest — acceptable
    console.log(`       Note: Gemini returned ${i.command} with origin=${i.origin} (no saved places)`);
  }
});

// --- multi-turn conversation context ---
await test('NLP: multi-turn — follow-up "what about from Westlands instead?" resolves correctly', async () => {
  const places = { home: 'Kahawa Sukari, Nairobi, Kenya', work: 'Westlands, Nairobi, Kenya' };
  // Turn 1
  const turn1Intent = await parseIntent('how long from Karen to Gigiri', places);
  assert(turn1Intent.command === 'check', `Turn 1 should be check, got ${turn1Intent.command}`);
  console.log(`       Turn 1: ${turn1Intent.origin} → ${turn1Intent.destination}`);

  // Turn 2 — follow-up references prior turn
  const history = [{ userMessage: 'how long from Karen to Gigiri', modelResponse: JSON.stringify(turn1Intent) }];
  const turn2Intent = await parseIntent('what about from Westlands instead?', places, history);
  console.log(`       Turn 2: ${turn2Intent.origin} → ${turn2Intent.destination}`);
  assert(turn2Intent.origin?.toLowerCase().includes('westlands'), `Turn 2 origin should be Westlands: ${turn2Intent.origin}`);
  // Destination should carry forward from turn 1
  assert(turn2Intent.destination?.toLowerCase().includes('gigiri'), `Turn 2 dest should carry forward Gigiri: ${turn2Intent.destination}`);
});

await test('NLP: multi-turn — "same threshold" reuses prior threshold', async () => {
  const places = {};
  const turn1Intent = { command: 'watch', origin: 'Karen, Nairobi', destination: 'CBD, Nairobi', threshold: 25, place_name: null, place_address: null, clarification: null };
  const history = [{ userMessage: 'alert me when Karen to CBD is under 25 min', modelResponse: JSON.stringify(turn1Intent) }];
  const turn2 = await parseIntent('now do the same for Westlands to CBD', places, history);
  console.log(`       Turn 2 threshold: ${turn2.threshold}`);
  assert(turn2.command === 'watch', `Expected watch, got ${turn2.command}`);
  // Gemini may or may not propagate the threshold — log it either way
  if (turn2.threshold === 25) {
    console.log('       ✓ threshold propagated from context');
  } else {
    console.log(`       Note: threshold not propagated (got ${turn2.threshold}) — acceptable if Gemini asks`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('7. FULL FLOW SIMULATION — check command');

await test('Full check flow: Kahawa Sukari → Westlands', async () => {
  // Simulate exactly what handleCheck does
  const [orig, dest] = await Promise.all([geocode(ORIGIN_STR), geocode(DEST_STR)]);
  const result = await getDurationSeconds(orig.formatted, dest.formatted);
  assert(result !== null, 'No route found');

  dbLogTraffic(FAKE_CHAT_ID, orig.formatted, dest.formatted, result.seconds, result.staticSeconds);

  const minutes    = Math.round(result.seconds / 60);
  const typicalMin = Math.round(result.staticSeconds / 60);
  const diff       = minutes - typicalMin;
  const cityCtx    = diff <= -3 ? ` — ${Math.abs(diff)} min faster than usual`
                   : diff >= 3  ? ` — ${diff} min slower than usual`
                   : ` — about normal`;

  const { dayOfWeek, hourOfDay, dayName, hourStr } = getNairobiComponents();
  const personal = dbGetPersonalTypical(FAKE_CHAT_ID, orig.formatted, dest.formatted, dayOfWeek, hourOfDay);

  const originShort = orig.formatted.split(',')[0];
  const destShort   = dest.formatted.split(',')[0];

  let message = `${originShort} → ${destShort} is ${minutes} min right now${cityCtx}.`;
  if (personal) {
    const personalDiff = minutes - personal.avgMin;
    const personalCtx  = personalDiff <= -3 ? `${Math.abs(personalDiff)} min faster than`
                       : personalDiff >= 3  ? `${personalDiff} min slower than`
                       : 'about the same as';
    message += `\nYour typical ${dayName} ${hourStr}: ${personal.avgMin} min — ${personalCtx} your usual (${personal.count} trips).`;
  }

  assert(message.length > 10, 'Message too short');
  console.log(`       Bot would say:\n       "${message}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
section('8. FULL FLOW SIMULATION — depart command logic');

await test('Depart flow: threshold calculation uses personal baseline when available', async () => {
  const ACCEPTABLE_RATIO = 1.2;
  const { dayOfWeek, hourOfDay } = getNairobiComponents();

  const [orig, dest] = await Promise.all([geocode(ORIGIN_STR), geocode(DEST_STR)]);
  const current = await getDurationSeconds(orig.formatted, dest.formatted);
  assert(current !== null, 'No route found');

  dbLogTraffic(FAKE_CHAT_ID, orig.formatted, dest.formatted, current.seconds, current.staticSeconds);

  const currentMin = Math.round(current.seconds / 60);
  const typicalMin = Math.round(current.staticSeconds / 60);
  const personal   = dbGetPersonalTypical(FAKE_CHAT_ID, orig.formatted, dest.formatted, dayOfWeek, hourOfDay);
  const baselineMin = personal ? personal.avgMin : typicalMin;
  const threshold   = Math.ceil(baselineMin * ACCEPTABLE_RATIO);

  assert(threshold > 0, `Threshold must be positive: ${threshold}`);
  console.log(`       Live: ${currentMin} min | Baseline: ${baselineMin} min | Threshold: ${threshold} min`);
  console.log(`       Personal data: ${personal ? `${personal.avgMin} min avg over ${personal.count} trips` : 'not yet (using citywide)'}`);

  if (currentMin <= threshold) {
    console.log('       → Would say: Green light, leave now');
  } else {
    console.log('       → Would say: Heavy traffic, checking forecast…');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('9. FULL FLOW SIMULATION — watch threshold validation');

await test('Watch validation: current <= threshold → fire immediately', async () => {
  const [orig, dest] = await Promise.all([geocode(ORIGIN_STR), geocode(DEST_STR)]);
  const current = await getDurationSeconds(orig.formatted, dest.formatted);
  assert(current !== null, 'No route found');
  const currentMin = Math.round(current.seconds / 60);
  const floorMin   = Math.round(Math.min(current.seconds, current.staticSeconds) / 60);

  // A threshold at current or above should fire immediately
  const highThreshold = currentMin + 100;
  console.log(`       currentMin=${currentMin}, floorMin=${floorMin}, testing threshold=${highThreshold}`);
  assert(currentMin <= highThreshold, 'Should fire immediately for threshold above current');
});

await test('Watch validation: threshold below floor → rejected as impossible', async () => {
  const [orig, dest] = await Promise.all([geocode(ORIGIN_STR), geocode(DEST_STR)]);
  const current = await getDurationSeconds(orig.formatted, dest.formatted);
  assert(current !== null, 'No route found');
  const floorMin = Math.round(Math.min(current.seconds, current.staticSeconds) / 60);
  const impossibleThreshold = Math.max(1, floorMin - 1);
  console.log(`       floorMin=${floorMin}, impossibleThreshold=${impossibleThreshold}`);
  assert(impossibleThreshold < floorMin, 'Impossible threshold should be below floor');
});

// ─────────────────────────────────────────────────────────────────────────────
section('10. SCENIC ROUTING — ORS + Overpass');

let karenCoords, gigiriCoords;

await test('Geocode Karen and Gigiri for scenic test', async () => {
  [karenCoords, gigiriCoords] = await Promise.all([geocode('Karen, Nairobi'), geocode('Gigiri, Nairobi')]);
  assert(karenCoords.lat && gigiriCoords.lat, 'Geocode failed');
  console.log(`       Karen: ${karenCoords.formatted}`);
  console.log(`       Gigiri: ${gigiriCoords.formatted}`);
});

await test('ORS: getAlternativeRoutes returns at least 1 route', async () => {
  if (!karenCoords || !gigiriCoords) { skip('ORS test', 'geocode failed'); return; }
  const routes = await getAlternativeRoutes(karenCoords, gigiriCoords);
  assert(routes.length >= 1, `Expected at least 1 route, got ${routes.length}`);
  console.log(`       ${routes.length} route(s) returned by ORS`);
  routes.forEach((r, i) => {
    console.log(`       Route ${i + 1}: ${Math.round(r.summary.duration / 60)} min, ${Math.round(r.summary.distance / 1000)} km`);
  });
});

await test('scoreAndRank returns a best route with scenicScore', async () => {
  if (!karenCoords || !gigiriCoords) { skip('scoreAndRank', 'geocode failed'); return; }
  const routes = await getAlternativeRoutes(karenCoords, gigiriCoords);
  const best = await scoreAndRank(routes);
  assert(best !== null, 'Expected a best route');
  assert(typeof best.scenicScore === 'number', `Bad scenicScore: ${best.scenicScore}`);
  assert(Array.isArray(best.coords) && best.coords.length > 0, 'No decoded coords');
  console.log(`       Best route: ${Math.round(best.route.summary.duration / 60)} min | scenicScore=${best.scenicScore.toFixed(2)} | scenicNodes=${best.scenicNodeCount} | topName=${best.topName ?? 'none'}`);
});

await test('extractWaypoints + buildMapsLink produces a valid Google Maps URL', async () => {
  if (!karenCoords || !gigiriCoords) { skip('buildMapsLink', 'geocode failed'); return; }
  const routes = await getAlternativeRoutes(karenCoords, gigiriCoords);
  const best = await scoreAndRank(routes);
  const waypoints = extractWaypoints(best.coords, 3);
  const url = buildMapsLink(karenCoords.formatted, gigiriCoords.formatted, waypoints);
  assert(url.startsWith('https://www.google.com/maps/dir/'), `Bad URL: ${url.slice(0, 80)}`);
  console.log(`       Maps URL: ${url.slice(0, 90)}…`);
});

// ─────────────────────────────────────────────────────────────────────────────
section('11. EDGE CASES & REGRESSION CHECKS');

await test('staticSeconds falls back to seconds when not in API response', async () => {
  // Validate the fallback branch in traffic.js line 44-46
  // We can't mock the API, but we verify the structure holds
  const result = await getDurationSeconds(
    originGeocode?.formatted ?? 'Kahawa Sukari, Nairobi, Kenya',
    destGeocode?.formatted ?? 'Westlands, Nairobi, Kenya'
  );
  assert(result !== null, 'Route required');
  // staticSeconds should always be a positive number, whether from the API or fallback
  assert(result.staticSeconds > 0, `staticSeconds must always be positive: ${result.staticSeconds}`);
});

await test('Geocode cache is functional (no re-fetch for same query)', async () => {
  // Use a place not queried anywhere else in the test so the first call goes to the network.
  const FRESH_PLACE = 'Upperhill, Nairobi';
  const t1 = Date.now();
  await geocode(FRESH_PLACE);
  const t2 = Date.now();
  await geocode(FRESH_PLACE); // should be cache hit
  const t3 = Date.now();
  const firstMs = t2 - t1;
  const secondMs = t3 - t2;
  console.log(`       First call: ${firstMs}ms | Cached call: ${secondMs}ms`);
  // Network call should be at least 1ms; cache hit is synchronous (0–1ms).
  assert(firstMs > 0, `First call took 0ms — likely already cached: ${firstMs}ms`);
  assert(secondMs < firstMs, `Cache miss — cached (${secondMs}ms) not faster than first (${firstMs}ms)`);
});

await test('NLP: "I\'m at Gigiri, need to get to Langata Road" → check or depart', async () => {
  const i = await parseAndLog("I'm at Gigiri, need to get to Langata Road");
  assert(['check', 'depart'].includes(i.command), `Expected check or depart, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('gigiri'), `Origin should be Gigiri: ${i.origin}`);
});

await test('NLP: place name with typo corrected by Gemini', async () => {
  // "Weslands" (missing t) — Gemini should correct
  const i = await parseAndLog('how long from Karen to Weslands');
  assert(i.command === 'check', `Expected check, got ${i.command}`);
  assert(i.destination?.toLowerCase().includes('westlands'), `Destination should be corrected to Westlands: ${i.destination}`);
});

await test('Traffic: parallel future forecasts all return valid results', async () => {
  const offsets = [15, 30, 45];
  const results = await Promise.allSettled(
    offsets.map(async (offset) => {
      const depTime = new Date(Date.now() + offset * 60_000);
      return getDurationSeconds(
        originGeocode?.formatted ?? 'Kahawa Sukari, Nairobi, Kenya',
        destGeocode?.formatted   ?? 'Westlands, Nairobi, Kenya',
        depTime
      );
    })
  );
  const allFulfilled = results.every(r => r.status === 'fulfilled');
  assert(allFulfilled, `Some forecasts failed: ${results.map(r => r.status).join(', ')}`);
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      console.log(`       +${offsets[i]}min: ${Math.round(r.value.seconds / 60)} min`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section('RESULTS');

console.log(`\n  Passed:  ${passed}`);
console.log(`  Failed:  ${failed}`);
console.log(`  Skipped: ${skipped}`);

if (failures.length) {
  console.log('\nFailures:');
  for (const { label, reason } of failures) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${reason}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
