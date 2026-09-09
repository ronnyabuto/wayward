// Regression suite for quickClassify — the regex fast-path in src/utils/nlp.js.
// Synchronous, no network, no Gemini quota cost. Run on every commit: `npm test`.
//
// 2026-09 rewrite: the free-text splitter no longer strips leading prefixes
// ("how long from", "matatu from", "distance from") or maintains a growing
// denylist of phrasings that broke it. It now only matches a strict, unprefixed
// "<origin> to <destination>" shape, with digits excluded from both slots by
// construction. Anything else defers to Gemini. See the comments in nlp.js on
// each remaining guard for why it's a closed category, not an incident list.
//
// Cases below are drawn from the real bug history (memory/bugs_fixed.md, git
// log on src/utils/nlp.js) plus the manual audit that motivated this rewrite
// (see scratch-archive/ for the original ad hoc scripts). Six previously-live
// bugs (traffic/matatu-prefix bleed, "Am going to X", "how long X to Y",
// "ping me when to leave...", implied deadlines without by/before) are now
// fixed as an emergent property of the stricter shape — verified below —
// rather than by adding six more one-off regexes.
import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quickClassify } from '../src/utils/nlp.js';

describe('matatu route number — closed grammar, always safe to hardcode', () => {
  test('route 23 matatu', () => {
    assert.deepEqual(quickClassify('route 23 matatu'), {
      command: 'matatu', origin: null, destination: null, route_number: '23',
    });
  });

  test('no. 7', () => {
    assert.deepEqual(quickClassify('no. 7'), {
      command: 'matatu', origin: null, destination: null, route_number: '7',
    });
  });
});

describe('deadline/departure-question guards — must defer to Gemini (return null)', () => {
  // git 6e16435: "what time should I leave X to get to Y by 8am" was hitting the
  // old `\bto\b` catch-all and returning `check` before Gemini ever saw the deadline.
  const mustDefer = [
    'what time should I leave Palace Apartments to get to Burn Manufacturing by 8am',
    'when should I leave for the airport',
    'niende lini ili nifike by 8',
    'Palace Apartments to Burn Manufacturing before 8',
    'I need to be there by 08:00',
    'I have a 9am meeting at Westlands',
    'Karen to CBD by 08:00',
    'Karen to CBD by 8',
    'matatu from CBD to Kibera before 18:00',
    'arriving at 6pm from Karen',
    'arrive by 8am',
  ];
  for (const msg of mustDefer) {
    test(`"${msg}"`, () => {
      assert.equal(quickClassify(msg), null);
    });
  }

  test('Karen to CBD 9am meeting — implied deadline with no by/before, digit excludes it structurally', () => {
    assert.equal(quickClassify('Karen to CBD 9am meeting'), null);
  });
});

describe('clean "X to Y" splitting — no prefix, no digits', () => {
  test('Karen to CBD', () => {
    assert.deepEqual(quickClassify('Karen to CBD'), {
      command: 'check', origin: 'Karen', destination: 'CBD', route_number: null,
    });
  });

  test('Sarit Centre to Junction Mall', () => {
    assert.deepEqual(quickClassify('Sarit Centre to Junction Mall'), {
      command: 'check', origin: 'Sarit Centre', destination: 'Junction Mall', route_number: null,
    });
  });

  test('Karen to CBD matatu — trailing qualifier selects the matatu command', () => {
    assert.deepEqual(quickClassify('Karen to CBD matatu'), {
      command: 'matatu', origin: 'Karen', destination: 'CBD', route_number: null,
    });
  });

  test('Karen to CBD?', () => {
    assert.deepEqual(quickClassify('Karen to CBD?'), {
      command: 'check', origin: 'Karen', destination: 'CBD', route_number: null,
    });
  });
});

describe('anything needing a prefix stripped now defers to Gemini', () => {
  // These used to be handled locally via prefix-stripping regexes. Gemini
  // handles them correctly anyway (and, for the corridor case, better —
  // quickClassify never populated the corridor field at all).
  const mustDefer = [
    'how long by road from Karen to CBD',
    'how thika road looking right now from kahawa sukari to cbd?',
    'matatu CBD to Westlands via by-pass',
    'distance from Karen to CBD',
  ];
  for (const msg of mustDefer) {
    test(`"${msg}"`, () => {
      assert.equal(quickClassify(msg), null);
    });
  }
});

describe('rejection guards — vague/alias/interrogative/domain-word/fragment inputs defer to Gemini', () => {
  const mustDefer = [
    'I want to be at X by 3pm. I am at Y. When should I leave?', // fragment start ("i")
    'want to go to Westlands from home',                          // fragment start ("want")
    'going to CBD from Karen',                                    // fragment start ("going")
    'from here to there',                                         // VAGUE
    'home to work',                                               // ALIAS
    'how long kileleshwa to westlands',                           // interrogative start ("how")
    'traffic from Westlands to CBD',                              // domain-word start ("traffic")
    'matatu from CBD to Kibera',                                  // domain-word start ("matatu")
    'Am going to Westlands',                                      // fragment start ("am")
    'ping me when to leave for the airport if my flight is at 10pm and I am at Karen', // digit excludes it
  ];
  for (const msg of mustDefer) {
    test(`"${msg}"`, () => {
      assert.equal(quickClassify(msg), null);
    });
  }
});
