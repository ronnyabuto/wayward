// Regression suite for quickClassify — the regex fast-path in src/utils/nlp.js.
// Synchronous, no network, no Gemini quota cost. Run on every commit: `npm test`.
//
// Cases below are drawn from the actual bug history (see memory/bugs_fixed.md and
// git log on src/utils/nlp.js) plus a manual audit run against the current code on
// 2026-09-09 (see the now-removed scratch scripts, archived in scratch-archive/).
// `test.todo(...)` entries are confirmed-live gaps found during that audit — they
// document the desired behavior without failing CI. Do not "fix" them by bolting on
// another regex guard without first checking whether quickClassify should even be
// attempting the case (see the free-text-splitter discussion from the 2026-09
// architecture review — most of these gaps are in the same open-ended splitter that
// review flagged as the wrong place to keep patching).
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
  // `\bto\b` catch-all and returning `check` before Gemini ever saw the deadline.
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
});

describe('DEADLINE_SIGNAL negative lookahead — unit phrases are not deadlines', () => {
  // These contain "by <number>" but mean seat/distance counts, not a time. They must
  // NOT be deferred on that basis alone (may still classify normally or return null
  // for other reasons, but not because of the by/before+digit guard).
  test('matatu CBD to Westlands via by-pass — "by-pass" is not a deadline', () => {
    const r = quickClassify('matatu CBD to Westlands via by-pass');
    assert.notEqual(r, null);
    assert.equal(r.command, 'matatu');
  });

  test('Karen to CBD 4 seater — unit phrase excluded from deadline match', () => {
    const r = quickClassify('Karen to CBD 4 seater');
    assert.notEqual(r, null);
  });
});

describe('clean "X to Y" splitting', () => {
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

  test('matatu CBD to Westlands', () => {
    assert.deepEqual(quickClassify('matatu CBD to Westlands'), {
      command: 'matatu', origin: 'CBD', destination: 'Westlands', route_number: null,
    });
  });

  // bugs_fixed.md: "0-min bug" — trailing "?" must not force the query to Gemini
  // unnecessarily, and the road-corridor bleed was fixed on the Gemini side.
  test('how thika road looking right now from kahawa sukari to cbd?', () => {
    const r = quickClassify('how thika road looking right now from kahawa sukari to cbd?');
    assert.notEqual(r, null);
    assert.equal(r.origin, 'kahawa sukari');
    assert.equal(r.destination, 'cbd');
  });

  test('how long by road from Karen to CBD — "how...from" prefix stripped', () => {
    assert.deepEqual(quickClassify('how long by road from Karen to CBD'), {
      command: 'check', origin: 'Karen', destination: 'CBD', route_number: null,
    });
  });
});

describe('rejection guards — vague/alias/fragment inputs defer to Gemini', () => {
  // bugs_fixed.md: quickClassify splits conversational messages on first "to".
  const mustDefer = [
    'I want to be at X by 3pm. I am at Y. When should I leave?',
    'want to go to Westlands from home',
    'going to CBD from Karen',
    'from here to there',
    'home to work',
  ];
  for (const msg of mustDefer) {
    test(`"${msg}"`, () => {
      assert.equal(quickClassify(msg), null);
    });
  }
});

describe('known gaps — found during 2026-09 audit, not yet fixed', () => {
  // results.txt (pre-existing manual test output) already showed this: a query-type
  // word ("traffic") not covered by the prefix-stripping alternation bleeds into the
  // origin instead of being recognized as a query qualifier.
  test.todo('traffic from Westlands to CBD — "traffic" should not bleed into origin', () => {
    const r = quickClassify('traffic from Westlands to CBD');
    assert.equal(r.origin, 'Westlands');
  });

  // Same root cause: the prefix-stripping group only fires on ONE literal alternative
  // ("mat(?:atu)?\s+" OR "from\s+", never both), so "matatu from X" only strips
  // "matatu " and leaves "from X" as the origin.
  test.todo('matatu from CBD to Kibera — "from" should not bleed into origin', () => {
    const r = quickClassify('matatu from CBD to Kibera');
    assert.equal(r.origin, 'CBD');
  });

  // The fragment-start rejection list (VAGUE/pronoun/verb guard) enumerates specific
  // verbs ("want", "going", "heading", ...) but not "am" — "Am going to X" slips
  // through and origin becomes the garbage fragment "Am going".
  test.todo('Am going to Westlands — should defer, not extract origin "Am going"', () => {
    assert.equal(quickClassify('Am going to Westlands'), null);
  });

  // "how long" is stripped only when followed by "...from" (see the passing case
  // above); without "from" it bleeds into the origin.
  test.todo('how long kileleshwa to westlands — "how long" should not bleed into origin', () => {
    const r = quickClassify('how long kileleshwa to westlands');
    assert.equal(r.origin, 'kileleshwa');
  });

  // This is the bot's single most-patched historical bug category (see git log:
  // "ping me when to leave" appears in multiple commit messages) and it is STILL
  // broken at the quickClassify layer: "ping" is not a DEPART_QUESTION trigger and
  // is not in the fragment-rejection list, so the whole sentence gets mangled
  // instead of deferring to Gemini, which handles this correctly via the CRITICAL
  // system-prompt rule.
  test.todo('ping me when to leave... — should defer to Gemini, not mangle the split', () => {
    assert.equal(
      quickClassify('ping me when to leave for the airport if my flight is at 10pm and I am at Karen'),
      null,
    );
  });

  // No by/before keyword, so DEADLINE_SIGNAL never fires, even though "9am meeting"
  // is exactly the deadline phrasing the Gemini system prompt has a dedicated
  // few-shot example for ("I have a 9am meeting" → depart, arrive_by "09:00").
  test.todo('Karen to CBD 9am meeting — implied deadline without by/before should defer', () => {
    assert.equal(quickClassify('Karen to CBD 9am meeting'), null);
  });
});
