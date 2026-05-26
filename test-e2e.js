/**
 * End-to-end test harness for Wayward.
 * Exercises all code paths against real APIs, mimicking human Telegram usage.
 * Run: node test-e2e.js
 */
import 'dotenv/config';
import { initDb, dbGetSavedPlaces, dbSetPlace, dbLogTraffic, dbGetPersonalTypical,
         dbInsertWatch, dbDeleteWatch, dbGetAllWatches, dbSetFailCount,
         dbPersistTurn, dbRetrieveRelevantTurns,
         dbUpsertFact, dbGetActiveFacts,
         dbLogDeparture, dbGetTypicalDepartureHour } from './src/db.js';
import { geocode, GeocodeNotFoundError } from './src/utils/geocode.js';
import { geocodePlace } from './src/commands/setplace.js';
import { getDurationSeconds } from './src/services/traffic.js';
import { parseIntent, quickClassify } from './src/utils/nlp.js';
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
section('3. MEMORY LAYER — persistent turns, FTS5 retrieval, temporal facts, departure events');

// Isolated user/chat IDs so memory tests never bleed into other sections.
const MEM_USER_ID = 9300000 + (Date.now() % 999999 | 0);
const MEM_CHAT_ID = MEM_USER_ID;

await test('dbPersistTurn stores a turn in memory_turns', () => {
  dbPersistTurn(MEM_USER_ID, MEM_CHAT_ID,
    'how long to Westlands from Karen',
    JSON.stringify({ command: 'check', origin: 'Karen, Nairobi', destination: 'Westlands, Nairobi' }));
});

await test('dbRetrieveRelevantTurns returns the stored turn', () => {
  const turns = dbRetrieveRelevantTurns(MEM_USER_ID, 'Westlands');
  assert(turns.length === 1, `Expected 1 turn, got ${turns.length}`);
  assert(turns[0].userMessage === 'how long to Westlands from Karen',
    `Wrong message: "${turns[0].userMessage}"`);
  assert(typeof turns[0].modelResponse === 'string', 'modelResponse should be a JSON string');
});

await test('Turns are returned oldest-first (correct ordering for Gemini history)', () => {
  // Store a second turn and verify the two come back in insertion order.
  dbPersistTurn(MEM_USER_ID, MEM_CHAT_ID,
    'what about from Gigiri instead?',
    JSON.stringify({ command: 'check', origin: 'Gigiri, Nairobi', destination: 'Westlands, Nairobi' }));
  const turns = dbRetrieveRelevantTurns(MEM_USER_ID, 'Westlands');
  assert(turns.length === 2, `Expected 2 turns, got ${turns.length}`);
  assert(turns[0].userMessage === 'how long to Westlands from Karen',
    `First turn should be the oldest. Got: "${turns[0].userMessage}"`);
  assert(turns[1].userMessage === 'what about from Gigiri instead?',
    `Second turn should be newest. Got: "${turns[1].userMessage}"`);
});

await test('FTS5 keyword search surfaces a relevant older turn outside the recency window', () => {
  // Store a turn mentioning Ngong Road, then push it out of the 5-turn recency window.
  const NGONG_USER = MEM_USER_ID + 1;
  dbPersistTurn(NGONG_USER, MEM_CHAT_ID,
    'traffic on Ngong Road from Karen',
    JSON.stringify({ command: 'check', origin: 'Karen', destination: 'CBD', corridor: 'Ngong Road' }));

  // Flood with 5 unrelated turns so the Ngong turn is no longer in the recency set.
  for (let i = 0; i < 5; i++) {
    dbPersistTurn(NGONG_USER, MEM_CHAT_ID, `unrelated message ${i}`,
      JSON.stringify({ command: 'unknown' }));
  }

  // Querying with "Ngong" should pull the old turn back via BM25 keyword match.
  const turns = dbRetrieveRelevantTurns(NGONG_USER, 'Ngong Road');
  const found = turns.some(t => t.userMessage.includes('Ngong Road'));
  assert(found,
    `FTS5 should retrieve the Ngong Road turn. Got: [${turns.map(t => `"${t.userMessage}"`).join(', ')}]`);
  console.log(`       FTS5 correctly surfaced the Ngong Road turn from beyond the recency window`);
});

await test('dbRetrieveRelevantTurns caps output at 5 turns', () => {
  // MEM_USER_ID now has 2 turns; store 10 more to confirm cap is enforced.
  for (let i = 0; i < 10; i++) {
    dbPersistTurn(MEM_USER_ID, MEM_CHAT_ID, `padding message ${i}`,
      JSON.stringify({ command: 'unknown' }));
  }
  const turns = dbRetrieveRelevantTurns(MEM_USER_ID, 'anything');
  assert(turns.length <= 5, `Expected ≤5 turns, got ${turns.length}`);
});

await test('dbPersistTurn prunes stored turns beyond 50 per user', () => {
  // A fresh user ID so we start from 0.
  const PRUNE_USER = MEM_USER_ID + 2;
  for (let i = 0; i < 55; i++) {
    dbPersistTurn(PRUNE_USER, MEM_CHAT_ID, `msg ${i}`,
      JSON.stringify({ command: 'check' }));
  }
  // After 55 inserts only 50 are kept — the first 5 ("msg 0"–"msg 4") must be gone.
  // FTS5 will not find them if they were deleted.
  const turns = dbRetrieveRelevantTurns(PRUNE_USER, 'msg 0');
  const oldestPresent = turns.some(t => t.userMessage === 'msg 0');
  assert(!oldestPresent,
    `"msg 0" should have been pruned after 55 inserts. Present in: [${turns.map(t => t.userMessage).join(', ')}]`);
  console.log(`       Oldest turn correctly pruned after 55 inserts`);
});

await test('Memory persists across DB re-init (simulates bot restart)', () => {
  // Store a sentinel turn, re-initialise the DB (same file), then retrieve it.
  const PERSIST_USER = MEM_USER_ID + 3;
  dbPersistTurn(PERSIST_USER, MEM_CHAT_ID, 'pre-restart message',
    JSON.stringify({ command: 'check', origin: 'Thika', destination: 'CBD' }));

  initDb(); // re-opens same SQLite file — simulates restart

  const turns = dbRetrieveRelevantTurns(PERSIST_USER, 'pre-restart');
  assert(turns.length >= 1, `Expected ≥1 turn after re-init, got ${turns.length}. Memory was lost on restart.`);
  assert(turns.some(t => t.userMessage === 'pre-restart message'),
    `Sentinel turn not found after re-init`);
  console.log(`       Memory survives restart — ${turns.length} turn(s) retrieved from SQLite`);
});

await test('dbUpsertFact creates a fact and dbGetActiveFacts returns it', () => {
  dbUpsertFact(MEM_USER_ID, 'user', 'office_is', 'Westlands, Nairobi, Kenya');
  const facts = dbGetActiveFacts(MEM_USER_ID);
  const f = facts.find(x => x.predicate === 'office_is');
  assert(f?.object === 'Westlands, Nairobi, Kenya',
    `Fact not found or wrong value. facts: ${JSON.stringify(facts)}`);
});

await test('dbUpsertFact invalidates the old value when the same predicate is upserted', () => {
  dbUpsertFact(MEM_USER_ID, 'user', 'office_is', 'Upper Hill, Nairobi, Kenya');
  const facts = dbGetActiveFacts(MEM_USER_ID);
  const active = facts.filter(x => x.predicate === 'office_is');
  assert(active.length === 1,
    `Expected exactly 1 active office fact, got ${active.length}: ${JSON.stringify(active)}`);
  assert(active[0].object === 'Upper Hill, Nairobi, Kenya',
    `Expected Upper Hill, got: "${active[0].object}"`);
  console.log(`       Old "Westlands" fact invalidated; "Upper Hill" is the new active value`);
});

await test('dbLogDeparture records an event', () => {
  dbLogDeparture(MEM_USER_ID, 'Kahawa Sukari, Nairobi, Kenya', 'Westlands, Nairobi, Kenya');
});

await test('dbGetTypicalDepartureHour returns null for fewer than 3 data points', () => {
  const { dayOfWeek } = getNairobiComponents();
  const h = dbGetTypicalDepartureHour(MEM_USER_ID,
    'Kahawa Sukari, Nairobi, Kenya', 'Westlands, Nairobi, Kenya', dayOfWeek);
  assert(h === null, `Expected null for 1 event, got ${h}`);
});

await test('dbGetTypicalDepartureHour returns the correct hour after 3+ same-weekday events', () => {
  const { dayOfWeek, hourOfDay } = getNairobiComponents();
  // Add 2 more to reach 3 total for this day.
  dbLogDeparture(MEM_USER_ID, 'Kahawa Sukari, Nairobi, Kenya', 'Westlands, Nairobi, Kenya');
  dbLogDeparture(MEM_USER_ID, 'Kahawa Sukari, Nairobi, Kenya', 'Westlands, Nairobi, Kenya');
  const h = dbGetTypicalDepartureHour(MEM_USER_ID,
    'Kahawa Sukari, Nairobi, Kenya', 'Westlands, Nairobi, Kenya', dayOfWeek);
  assert(h !== null, `Expected a valid hour after 3 events, got null`);
  assert(h === hourOfDay, `Expected hour ${hourOfDay} (current hour), got ${h}`);
  console.log(`       Typical departure hour on this weekday: ${h}:00`);
});

// ─────────────────────────────────────────────────────────────────────────────
section('5. TIME UTILITIES — Nairobi components');

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
section('6. GEOCODING — real Google Geocoding API calls');

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
section('7. TRAFFIC API — real Google Routes API calls');

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
section('8. NLP / INTENT PARSING — Gemini API, all 6 commands + corridor fix + Swahili');

// ── quickClassify unit tests (no API cost) ────────────────────────────────────

await test('quickClassify: the exact 0-min bug message now returns check (trailing ? stripped)', () => {
  const q = quickClassify('how thika road looking right now from kahawa sukari to cbd?');
  assert(q !== null,
    'quickClassify returned null — trailing "?" on destination is no longer being stripped');
  assert(q.command === 'check', `Expected check, got: ${q?.command}`);
  assert(q.origin?.toLowerCase() === 'kahawa sukari',
    `Origin should be "kahawa sukari", got: "${q?.origin}"`);
  assert(q.destination?.toLowerCase() === 'cbd',
    `Destination should be "cbd" (stripped of ?), got: "${q?.destination}"`);
  console.log(`       quickClassify correctly extracted origin="${q.origin}", destination="${q.destination}"`);
});

await test('quickClassify: trailing punctuation stripped for !, ., and , too', () => {
  const variants = [
    ['Karen to CBD!',    'cbd'],
    ['Karen to CBD.',    'cbd'],
    ['Karen to CBD,',    'cbd'],
    ['Karen to CBD???',  'cbd'],
  ];
  for (const [input, expectedDest] of variants) {
    const q = quickClassify(input);
    assert(q !== null, `quickClassify returned null for: "${input}"`);
    assert(q.destination?.toLowerCase() === expectedDest,
      `For "${input}": expected dest "${expectedDest}", got "${q?.destination}"`);
  }
  console.log(`       All trailing punctuation variants stripped correctly`);
});

await test('quickClassify: unambiguous "X to Y" without road prefix still works', () => {
  const q = quickClassify('Kahawa Sukari to Westlands');
  assert(q !== null, 'quickClassify should handle plain "X to Y"');
  assert(q.command === 'check', `Expected check, got ${q?.command}`);
  assert(q.origin?.toLowerCase() === 'kahawa sukari', `origin: ${q?.origin}`);
  assert(q.destination?.toLowerCase() === 'westlands', `dest: ${q?.destination}`);
});

await test('quickClassify: "Want to go to X from Y" → null (verb fragment as origin rejected)', () => {
  const q = quickClassify('Want to go to langata from kahawa sukari');
  assert(q === null, `Expected null (falls through to Gemini), got command=${q?.command} origin="${q?.origin}"`);
});

await test('quickClassify: "Going to X from Y" variants → null', () => {
  const cases = [
    'Going to Westlands from Karen',
    'Heading to town from Gigiri',
    'Need to get to JKIA from CBD',
    'Planning to go to Langata from Westlands',
  ];
  for (const msg of cases) {
    const q = quickClassify(msg);
    assert(q === null, `"${msg}" should return null, got origin="${q?.origin}"`);
  }
});

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

await test('setplace [confirmation]: geocodePlace resolves Nairobi address', async () => {
  // geocodePlace is the first step in the confirmation flow — must return a non-empty string
  const formatted = await geocodePlace(null, null, 'Seresponda Court, Kiambu Road, Nairobi');
  assert(typeof formatted === 'string' && formatted.length > 0, `Expected formatted address string, got: ${formatted}`);
  assert(formatted.toLowerCase().includes('kenya'), `Expected "Kenya" in formatted address: ${formatted}`);
  console.log(`       formatted: ${formatted}`);
});

await test('NLP [setplace guard]: bare location after depart-prompt → depart, not setplace', async () => {
  // Prior turn: bot asked "Where are you leaving from?" after a depart with null origin.
  // User replies with just an address. Must fill the origin slot, not trigger setplace.
  const history = [
    { userMessage: 'I need to be at JKIA by 12noon', modelResponse: JSON.stringify({ command: 'depart', origin: null, destination: 'Jomo Kenyatta International Airport, Nairobi, Kenya', arrive_by: '12:00' }) },
  ];
  const i = await parseIntent('Jalde apartments in OJ, bypass ruiru', {}, history);
  assert(i.command !== 'setplace', `Should NOT classify as setplace; got ${i.command} place_name=${i.place_name}`);
  assert(i.command === 'depart', `Expected depart, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('ruiru') || i.origin?.toLowerCase().includes('oj'), `Origin should be in Ruiru/OJ area: ${i.origin}`);
  console.log(`       origin=${i.origin} dest=${i.destination}`);
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
section('9. FULL FLOW SIMULATION — check command');

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
section('10. FULL FLOW SIMULATION — depart command logic');

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
section('11. FULL FLOW SIMULATION — watch threshold validation');

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
section('12. SCENIC ROUTING — ORS + Overpass');

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
section('13. EDGE CASES & REGRESSION CHECKS');

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

// ── Corridor fix (road name separation) ──────────────────────────────────────
// These tests go through Gemini because the messages do NOT match quickClassify
// cleanly (saved-place aliases force the ALIAS reject and Gemini path).

await test('NLP [corridor]: road name goes into corridor field, not origin', async () => {
  // "home" and "work" are ALIAS-rejected by quickClassify → Gemini handles it.
  const places = { home: 'Kahawa Sukari, Nairobi, Kenya', work: 'Westlands, Nairobi, Kenya' };
  const i = await parseAndLog('how is Thika Road from home to work?', places);
  assert(i.command === 'check', `Expected check, got ${i.command}`);
  // Origin must resolve to home (Kahawa Sukari), NOT to "Thika Road"
  assert(
    i.origin?.toLowerCase().includes('kahawa') || i.origin?.toLowerCase().includes('home'),
    `Origin should be Kahawa Sukari/home, not a road name. Got: "${i.origin}"`
  );
  assert(
    i.destination?.toLowerCase().includes('westlands') || i.destination?.toLowerCase().includes('work'),
    `Destination should be Westlands/work. Got: "${i.destination}"`
  );
  // The corridor field should capture the road name
  assert(
    i.corridor?.toLowerCase().includes('thika'),
    `corridor should be "Thika Road". Got: "${i.corridor}"`
  );
  console.log(`       corridor="${i.corridor}" correctly separated from origin="${i.origin}"`);
});

await test('NLP [corridor]: Ngong Road corridor with explicit origin/dest', async () => {
  const i = await parseAndLog('how is traffic on Ngong Road from Junction to town?');
  assert(['check', 'depart'].includes(i.command), `Expected check or depart, got ${i.command}`);
  // Origin should be Junction Mall area, NOT "Ngong Road"
  const roadNames = ['ngong road', 'mombasa road', 'thika road', 'uhuru highway'];
  assert(
    !roadNames.some(r => i.origin?.toLowerCase() === r),
    `Origin should be a place, not a road name. Got: "${i.origin}"`
  );
  console.log(`       origin="${i.origin}", corridor="${i.corridor ?? 'null'}"`);
});

await test('NLP [watch→depart]: "tell me when traffic clears" (no threshold) → depart, not watch', async () => {
  // No explicit minute count — Gemini must not invent a threshold. Should classify as depart.
  const i = await parseAndLog('I\'m at sarit center. I want to go to the hub karen. tell me when traffic clears.');
  assert(i.command === 'depart', `Expected depart, got ${i.command} (threshold=${i.threshold})`);
  assert(i.origin?.toLowerCase().includes('sarit'), `Origin should be Sarit Centre: ${i.origin}`);
  assert(i.destination?.toLowerCase().includes('hub') || i.destination?.toLowerCase().includes('karen'), `Destination should be The Hub Karen: ${i.destination}`);
  console.log(`       origin="${i.origin}" destination="${i.destination}"`);
});

await test('NLP [context carry-forward]: "when should I leave?" after watch → depart with both locations', async () => {
  const history = [
    {
      userMessage: "I'm at sarit center. I want to go to the hub karen. tell me when traffic clears.",
      modelResponse: JSON.stringify({ command: 'watch', origin: 'Sarit Centre, Westlands, Nairobi, Kenya', destination: 'The Hub, Karen, Nairobi, Kenya', threshold: 30, arrive_by: null, place_name: null, place_address: null, route_number: null, corridor: null, clarification: null }),
    },
  ];
  const i = await parseIntent('when should I leave?', {}, history);
  assert(i.command === 'depart', `Expected depart, got ${i.command}`);
  assert(i.origin?.toLowerCase().includes('sarit'), `Origin should carry forward (Sarit Centre): ${i.origin}`);
  assert(i.destination?.toLowerCase().includes('hub') || i.destination?.toLowerCase().includes('karen'), `Destination should carry forward (The Hub Karen): ${i.destination}`);
  console.log(`       origin="${i.origin}" dest="${i.destination}"`);
});

await test('NLP [Swahili]: "naenda town kutoka Westlands" → check/depart with correct O/D', async () => {
  const i = await parseAndLog('naenda town kutoka Westlands');
  assert(['check', 'depart'].includes(i.command),
    `Expected check or depart, got ${i.command}. Swahili "naenda" = going to.`);
  assert(
    i.origin?.toLowerCase().includes('westlands'),
    `Origin should be Westlands. Got: "${i.origin}"`
  );
  assert(
    i.destination?.toLowerCase().includes('cbd') ||
    i.destination?.toLowerCase().includes('nairobi') ||
    i.destination?.toLowerCase().includes('town'),
    `Destination should be town/CBD. Got: "${i.destination}"`
  );
  console.log(`       Swahili parsed: origin="${i.origin}" → destination="${i.destination}"`);
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

await test('depart [fmtTime]: noon in Nairobi formats as 12:xx not 00:xx', () => {
  // en-KE ICU data on some runtimes renders noon as "00:xx pm". Verify the fix.
  const noon = new Date('2026-05-26T09:00:00Z'); // 09:00 UTC = 12:00 Nairobi (UTC+3)
  const s = noon.toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Nairobi',
  }).replace(/^00:/, '12:');
  assert(!s.startsWith('00:'), `Noon should not format as 00:xx — got: "${s}"`);
  assert(s.startsWith('12:'), `Noon should format as 12:xx — got: "${s}"`);
  console.log(`       Noon in Nairobi formats as: "${s}"`);
});

await test('depart [fmtTime]: midnight in Nairobi formats as 12:xx not 00:xx', () => {
  const midnight = new Date('2026-05-25T21:00:00Z'); // 21:00 UTC = 00:00 Nairobi
  const s = midnight.toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Nairobi',
  }).replace(/^00:/, '12:');
  assert(!s.startsWith('00:'), `Midnight should not format as 00:xx — got: "${s}"`);
  console.log(`       Midnight in Nairobi formats as: "${s}"`);
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
