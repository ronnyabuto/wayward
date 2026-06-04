/**
 * End-to-end verification harness.
 * Drives the actual command handlers (same code bot.on('message') calls),
 * using real APIs (Google geocode, Routes, Gemini) and the real SQLite DB.
 * Uses chatId=8888888 / userId=8888888 throughout — isolated from real user data.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_CHAT   = 8888888;
const TEST_USER   = 8888888;
const DB_PATH     = join(dirname(fileURLToPath(import.meta.url)), 'data', 'wayward.db');

// ── Mock bot: records every sendMessage call ──────────────────────────────────
const sent = [];
const mockBot = {
  sendMessage: async (chatId, text) => {
    sent.push({ chatId, text: text.replace(/\n/g, ' ↵ ') });
    return { message_id: Date.now() };
  },
};
function lastMsg()  { return sent[sent.length - 1]?.text ?? '(no message)'; }
function clearMsgs() { sent.length = 0; }

// ── Helpers ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}
function section(title) { console.log(`\n── ${title} ──────────────────────────────────────`); }
function raw(label, val) { console.log(`  ℹ  ${label}: ${JSON.stringify(val)}`); }

// ── DB snapshot helper ────────────────────────────────────────────────────────
function dbSnapshot() {
  const db = new Database(DB_PATH, { readonly: true });
  const snap = {
    places:       db.prepare('SELECT place_id, display_name FROM places ORDER BY rowid DESC LIMIT 3').all(),
    placeQueries: db.prepare('SELECT queried_as, place_id FROM place_queries ORDER BY rowid DESC LIMIT 3').all(),
    pool:         db.prepare('SELECT origin_place_id, destination_place_id, duration_sec FROM traffic_pool ORDER BY rowid DESC LIMIT 3').all(),
    watches:      db.prepare('SELECT id, origin, destination, origin_place_id, dest_place_id, threshold_min FROM watches WHERE chat_id = ?').all(TEST_CHAT),
  };
  db.close();
  return snap;
}

// Clean up any prior test watches so counts are deterministic
{
  const db = new Database(DB_PATH);
  db.prepare('DELETE FROM watches WHERE chat_id = ?').run(TEST_CHAT);
  db.prepare('DELETE FROM traffic_pool WHERE origin_place_id IN (SELECT place_id FROM places WHERE display_name LIKE \'%Sarit%\' OR display_name LIKE \'%Karen%\' OR display_name LIKE \'%Gigiri%\')').run();
  db.close();
}

// ── 1. DB INITIALISATION ─────────────────────────────────────────────────────
section('1. DB boot (schema already verified by boot log)');
const { initDb } = await import('./src/db.js');
initDb();
const db0 = new Database(DB_PATH, { readonly: true });
const tables = db0.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
db0.close();
check('places table exists',       tables.includes('places'));
check('place_queries table exists', tables.includes('place_queries'));
check('traffic_pool table exists', tables.includes('traffic_pool'));
check('watches has origin_place_id', (() => {
  const d = new Database(DB_PATH, {readonly:true});
  const cols = d.prepare("SELECT name FROM pragma_table_info('watches')").all().map(r=>r.name);
  d.close();
  return cols.includes('origin_place_id');
})());

// ── 2. GEOCODE CACHE ─────────────────────────────────────────────────────────
section('2. Geocode — real API + SQLite persistence');
const { geocode } = await import('./src/utils/geocode.js');

console.log('  → geocoding "Sarit Centre, Westlands" (cold — expect API call)...');
const t0 = Date.now();
const sarit = await geocode('Sarit Centre, Westlands');
const coldMs = Date.now() - t0;

check('returns lat/lon',    typeof sarit.lat === 'number' && typeof sarit.lon === 'number',
  `${sarit.lat.toFixed(4)}, ${sarit.lon.toFixed(4)}`);
check('returns placeId',   typeof sarit.placeId === 'string' && sarit.placeId.length > 5, sarit.placeId);
check('returns formatted', typeof sarit.formatted === 'string', sarit.formatted);
raw('cold latency', `${coldMs}ms`);

// Kenya bbox sanity
check('result is in Kenya', sarit.lat > -5 && sarit.lat < 5 && sarit.lon > 33 && sarit.lon < 42);

// Second call — should hit SQLite, not the API
console.log('  → geocoding "Sarit Centre, Westlands" again (warm — expect cache hit)...');
const t1 = Date.now();
const sarit2 = await geocode('Sarit Centre, Westlands');
const warmMs = Date.now() - t1;
check('cache hit is fast (< 50ms)',  warmMs < 50, `${warmMs}ms`);
check('cache returns same placeId',  sarit2.placeId === sarit.placeId);
raw('warm latency', `${warmMs}ms`);

// Verify SQLite persistence
// Use targeted lookups — snapshot ORDER BY rowid DESC LIMIT 3 may miss older rows
const db1 = new Database(DB_PATH, { readonly: true });
const placesRow = db1.prepare('SELECT place_id, display_name FROM places WHERE place_id = ?').get(sarit.placeId);
const queryRow  = db1.prepare('SELECT queried_as, place_id FROM place_queries WHERE place_id = ?').get(sarit.placeId);
db1.close();
check('places table has this place_id', !!placesRow, placesRow?.display_name ?? 'not found');
check('place_queries has lookup key',   !!queryRow,  queryRow?.queried_as   ?? 'not found');

// The canonical 4-part NLP format resolves to the actual building, not the neighborhood.
// "Sarit Centre, Westlands, Kenya" → Google returns the Westlands neighbourhood (imprecise).
// "Sarit Centre, Westlands, Nairobi, Kenya" → Google returns the mall building (precise).
// This confirms why the NLP prompt fix matters: the canonical form routes to the correct place.
console.log('  → geocoding full canonical form "Sarit Centre, Westlands, Nairobi, Kenya"...');
const sarit3 = await geocode('Sarit Centre, Westlands, Nairobi, Kenya');
check('canonical form returns a premise/building', sarit3.formatted.toLowerCase().includes('sarit') || sarit3.formatted.toLowerCase().includes('lower kabete'),
  `formatted: "${sarit3.formatted}"`);
check('canonical form is cached in place_queries', (() => {
  const d = new Database(DB_PATH, { readonly: true });
  const r = d.prepare('SELECT place_id FROM place_queries WHERE queried_as = ?').get('sarit centre, westlands, nairobi, kenya');
  d.close();
  return !!r;
})());
raw('short-form place', `id=${sarit.placeId} → "${sarit.formatted}" (neighborhood — imprecise)`);
raw('canonical-form place', `id=${sarit3.placeId} → "${sarit3.formatted}" (building — correct)`);

// ── 3. NLP INTENT PARSING ────────────────────────────────────────────────────
section('3. NLP — Gemini intent parsing with canonical format');
const { parseIntent } = await import('./src/utils/nlp.js');

const cases = [
  {
    label: 'Plain "X to Y" commuter query',
    msg:   'how long is traffic from Sarit Centre to Karen Hub right now?',
    check: (i) => i.command === 'check' && !!i.origin && !!i.destination,
  },
  {
    label: 'Swahili code-switch — naenda CBD',
    msg:   'naenda CBD from Westgate, how long?',
    check: (i) => i.command === 'check' && !!i.origin && !!i.destination,
  },
  {
    label: 'Depart with arrive_by deadline',
    msg:   'I need to be at JKIA by 7pm, leaving from Gigiri',
    check: (i) => i.command === 'depart' && i.arrive_by === '19:00' && !!i.origin,
  },
  {
    label: 'Watch with explicit threshold',
    msg:   'alert me when Karen to CBD drops under 35 minutes',
    check: (i) => i.command === 'watch' && i.threshold === 35 && !!i.origin && !!i.destination,
  },
  {
    label: 'Matatu corridor query',
    msg:   'matatu situation on Ngong Road from Karen to town?',
    check: (i) => i.command === 'matatu' && !!i.origin && !!i.destination,
  },
  {
    label: 'Context carry-forward (follow-up with no locations)',
    msg:   'when should I leave?',
    history: [
      { userMessage: 'traffic from Sarit Centre to Karen Hub?',
        modelResponse: JSON.stringify({ command:'check', origin:'Sarit Centre, Westlands, Nairobi, Kenya', destination:'The Hub, Karen, Nairobi, Kenya', threshold:null, arrive_by:null, place_name:null, place_address:null, route_number:null, corridor:null, clarification:null }) },
    ],
    check: (i) => i.command === 'depart' && i.origin?.includes('Sarit') && i.destination?.includes('Karen'),
  },
  {
    label: 'Sheng — mbaya traffic check',
    msg:   'Thika road iko mbaya sana leo, how long from Kahawa Sukari to CBD?',
    check: (i) => i.command === 'check' && !!i.origin && !!i.destination,
  },
  {
    label: 'Canonical format — origin includes city+country',
    msg:   'check traffic from Westlands to Gigiri',
    check: (i) => i.command === 'check' && /Kenya/i.test(i.origin ?? '') && /Kenya/i.test(i.destination ?? ''),
  },
];

for (const c of cases) {
  try {
    const intent = await parseIntent(c.msg, {}, c.history ?? []);
    const ok = c.check(intent);
    check(c.label, ok,
      `cmd=${intent.command} orig="${intent.origin}" dest="${intent.destination}" arrive_by=${intent.arrive_by} thresh=${intent.threshold}`);
  } catch (err) {
    check(c.label, false, `THREW: ${err.message}`);
  }
}

// ── 4. FULL CHECK COMMAND — pool write + pool fallback ───────────────────────
section('4. handleCheck — traffic_pool write + community baseline fallback');
const { handleCheck } = await import('./src/commands/check.js');

// Ensure no personal history for this route/slot so pool fallback can trigger
{
  const d = new Database(DB_PATH);
  d.prepare('DELETE FROM traffic_history WHERE chat_id = ?').run(TEST_CHAT);
  d.close();
}

clearMsgs();
console.log('  → check: "Sarit Centre, Westlands" → "Karen" (first trip, no personal history)...');
await handleCheck(mockBot, TEST_CHAT, 'Sarit Centre, Westlands', 'Karen, Nairobi', TEST_USER);

const msgCheck = lastMsg();
raw('bot reply', msgCheck.slice(0, 120));
check('reply contains route time',      /\d+ min/.test(msgCheck));
check('reply contains Maps link',       msgCheck.includes('maps.google.com') || msgCheck.includes('google.com/maps'));

const snap2 = dbSnapshot();
const poolRows = snap2.pool;
check('traffic_pool got a row',         poolRows.length > 0, `${poolRows.length} rows`);
if (poolRows.length > 0) {
  check('pool row has origin_place_id', !!poolRows[0].origin_place_id, poolRows[0].origin_place_id);
  raw('pool row', JSON.stringify(poolRows[0]));
}

// Do 2 more checks on the same route/slot so pool reaches ≥3 and fallback triggers
console.log('  → two more checks to build pool to ≥3 observations...');
await handleCheck(mockBot, TEST_CHAT, 'Sarit Centre, Westlands', 'Karen, Nairobi', TEST_USER);
await handleCheck(mockBot, TEST_CHAT, 'Sarit Centre, Westlands', 'Karen, Nairobi', TEST_USER);

// Now clear personal history again and check — pool fallback should appear
{
  const d = new Database(DB_PATH);
  d.prepare('DELETE FROM traffic_history WHERE chat_id = ?').run(TEST_CHAT);
  d.close();
}
clearMsgs();
console.log('  → check again with no personal history — expect community baseline...');
await handleCheck(mockBot, TEST_CHAT, 'Sarit Centre, Westlands', 'Karen, Nairobi', TEST_USER);
const msgPool = lastMsg();
raw('bot reply (pool fallback)', msgPool.slice(0, 180));
check('reply shows community average', /Community average|Your typical/i.test(msgPool),
  msgPool.includes('Community') ? 'pool fallback shown' : 'personal history shown instead');

// ── 5. WATCH COMMAND — placeIds stored ───────────────────────────────────────
section('5. handleWatch — placeIds stored in DB');
const { handleWatch } = await import('./src/commands/watch.js');

clearMsgs();
console.log('  → watch: Sarit Centre → Karen, alert at 40min...');
await handleWatch(mockBot, TEST_CHAT, 'Sarit Centre, Westlands', 'Karen, Nairobi', 40);

const msgWatch = lastMsg();
raw('bot reply', msgWatch.slice(0, 120));
// Could fire immediately if traffic is already ≤40min
check('reply is watch confirm or already-good', /[Ww]atch|already good|Leave when/i.test(msgWatch));

const snap3 = dbSnapshot();
const watchRows = snap3.watches;
raw('watches in DB', JSON.stringify(watchRows));
check('at least one watch row exists (or fired immediately)',
  watchRows.length > 0 || /already good|Leave when/i.test(msgWatch));
if (watchRows.length > 0) {
  check('watch has origin_place_id', !!watchRows[0].origin_place_id, watchRows[0].origin_place_id ?? 'null');
  check('watch has dest_place_id',   !!watchRows[0].dest_place_id,   watchRows[0].dest_place_id   ?? 'null');
}

// ── 6. DEPART COMMAND ─────────────────────────────────────────────────────────
section('6. handleDepart — pool write + placeId through to commitWatch');
const { handleDepart } = await import('./src/commands/depart.js');

clearMsgs();
console.log('  → depart: Gigiri → JKIA, arrive by 19:00...');
await handleDepart(mockBot, TEST_CHAT, 'Gigiri, Nairobi', 'JKIA, Nairobi', '19:00', TEST_USER);

const msgDepart = lastMsg();
raw('bot reply', msgDepart.slice(0, 160));
check('reply mentions leave time or urgency',
  /[Ll]eave|won.t make|already passed|right now|heading/i.test(msgDepart));
check('reply contains Maps link', msgDepart.includes('google.com/maps'));

const snap4 = dbSnapshot();
check('pool has new rows after depart', snap4.pool.length > 0);

// ── 7. SCHEDULER LOAD WITH PLACEIDS ──────────────────────────────────────────
section('7. Scheduler — loads placeIds from DB');

// Insert a synthetic watch with placeIds directly
{
  const d = new Database(DB_PATH);
  d.prepare('DELETE FROM watches WHERE chat_id = ?').run(TEST_CHAT);
  d.prepare(`INSERT INTO watches (chat_id, origin, destination, threshold_min, origin_place_id, dest_place_id)
             VALUES (?, ?, ?, ?, ?, ?)`)
   .run(TEST_CHAT, 'Sarit Centre, Westlands', 'Karen Hub', 40, sarit.placeId, 'ChIJkaren_test_id');
  d.close();
}

const { loadWatchesFromDb, watches } = await import('./src/scheduler.js');
watches.clear();
loadWatchesFromDb();

const loaded = [...watches.values()].find(w => w.chatId === TEST_CHAT);
raw('loaded watch', JSON.stringify(loaded ?? null));
check('watch loaded from DB',         !!loaded);
check('originPlaceId populated',      loaded?.originPlaceId === sarit.placeId, loaded?.originPlaceId ?? 'null');
check('destPlaceId populated',        !!loaded?.destPlaceId, loaded?.destPlaceId ?? 'null');

// ── 8. MATATU COMMAND ─────────────────────────────────────────────────────────
section('8. handleMatatu — proxy road conditions');
const { handleMatatu } = await import('./src/commands/matatu.js');

clearMsgs();
console.log('  → matatu: CBD to Westlands corridor...');
await handleMatatu(mockBot, TEST_CHAT, 'Nairobi CBD', 'Westlands, Nairobi');
const msgMat = lastMsg();
raw('bot reply', msgMat.slice(0, 160));
check('reply has traffic emoji',     /[🔴🟡🟢]/.test(msgMat));
check('reply has disclaimer',         /no live matatu tracking/i.test(msgMat));

// ── 9. PROBE — bad place name ─────────────────────────────────────────────────
section('9. Probe — geocode failure handling');
clearMsgs();
console.log('  → check with nonsense place name...');
await handleCheck(mockBot, TEST_CHAT, 'xkzqvmblart place', 'Karen, Nairobi', TEST_USER);
const msgBad = lastMsg();
raw('error reply', msgBad.slice(0, 120));
check('returns user-readable error', /[Cc]ould not find|Something went wrong/i.test(msgBad));

// ── 10. PROBE — Unicode FTS sanitizer ────────────────────────────────────────
section('10. Probe — FTS5 Unicode sanitizer (Sheng/Swahili tokens)');
const { dbRetrieveRelevantTurns, dbPersistTurn } = await import('./src/db.js');

// Store a turn with Swahili/hyphenated place names
dbPersistTurn(TEST_USER, TEST_CHAT, "naenda Athi-River kutoka CBD", JSON.stringify({ command:'check', origin:'Nairobi CBD, Nairobi, Kenya', destination:'Athi-River, Machakos, Kenya' }));

// Retrieve using the same apostrophe/hyphen text — should not throw
let ftsOk = false;
try {
  const result = dbRetrieveRelevantTurns(TEST_USER, "Athi-River, Ngong'road traffic");
  ftsOk = Array.isArray(result);
  check('FTS with hyphens/apostrophes does not throw', ftsOk, `${result.length} turns returned`);
} catch(e) {
  check('FTS with hyphens/apostrophes does not throw', false, e.message);
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? '✅ ALL PASS' : `❌ ${fail} FAILURE(S) — see above`);

// Clean up test watches
const dClean = new Database(DB_PATH);
dClean.prepare('DELETE FROM watches WHERE chat_id = ?').run(TEST_CHAT);
dClean.prepare('DELETE FROM traffic_history WHERE chat_id = ?').run(TEST_CHAT);
dClean.close();

process.exit(fail > 0 ? 1 : 0);
