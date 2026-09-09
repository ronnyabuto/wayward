// Golden-set regression suite for parseIntent (calls the real Gemini API — costs
// quota, so it is NOT part of the default `npm test` run).
//
// Run explicitly whenever SYSTEM_PROMPT or RESPONSE_SCHEMA in src/utils/nlp.js
// changes, and always run the FULL set — not just the one case you think you fixed.
// This is the direct fix for the historical failure mode where a prompt edit fixed
// one case and silently broke another (see git 00ebc79 / e4f82a5, two minutes
// apart, on the same "Key distinctions" list this fixture exercises).
//
//   RUN_GOLDEN_TESTS=1 npm run test:golden
//
// Cases are drawn from test/fixtures/parseIntent.golden.json, each traceable to a
// specific system-prompt rule or historical bug (see the "note" field per case).
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIntent } from '../src/utils/nlp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'parseIntent.golden.json'), 'utf8'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free-tier Gemini Flash-Lite is 15 RPM — space calls out to stay well under that.
const DELAY_MS = 4500;

const shouldRun = process.env.RUN_GOLDEN_TESTS === '1';

test('parseIntent golden set', { skip: !shouldRun && 'set RUN_GOLDEN_TESTS=1 to run (costs Gemini quota)' }, async () => {
  const failures = [];

  for (const c of fixtures) {
    let intent;
    try {
      intent = await parseIntent(c.userMessage, c.savedPlaces ?? {}, c.conversationHistory ?? []);
    } catch (err) {
      failures.push(`[${c.id}] parseIntent threw: ${err.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    const mismatches = [];
    const exp = c.expect;

    if ('command' in exp && intent.command !== exp.command) {
      mismatches.push(`command: expected "${exp.command}", got "${intent.command}"`);
    }
    if ('arrive_by' in exp && intent.arrive_by !== exp.arrive_by) {
      mismatches.push(`arrive_by: expected ${JSON.stringify(exp.arrive_by)}, got ${JSON.stringify(intent.arrive_by)}`);
    }
    if ('depart_after' in exp && intent.depart_after !== exp.depart_after) {
      mismatches.push(`depart_after: expected ${JSON.stringify(exp.depart_after)}, got ${JSON.stringify(intent.depart_after)}`);
    }
    if ('threshold' in exp && intent.threshold !== exp.threshold) {
      mismatches.push(`threshold: expected ${exp.threshold}, got ${intent.threshold}`);
    }
    if ('place_name' in exp && intent.place_name !== exp.place_name) {
      mismatches.push(`place_name: expected "${exp.place_name}", got "${intent.place_name}"`);
    }
    if ('originIncludes' in exp && !(intent.origin ?? '').toLowerCase().includes(exp.originIncludes.toLowerCase())) {
      mismatches.push(`origin: expected to include "${exp.originIncludes}", got "${intent.origin}"`);
    }
    if ('destinationIncludes' in exp && !(intent.destination ?? '').toLowerCase().includes(exp.destinationIncludes.toLowerCase())) {
      mismatches.push(`destination: expected to include "${exp.destinationIncludes}", got "${intent.destination}"`);
    }
    if ('corridorIncludes' in exp && !(intent.corridor ?? '').toLowerCase().includes(exp.corridorIncludes.toLowerCase())) {
      mismatches.push(`corridor: expected to include "${exp.corridorIncludes}", got "${intent.corridor}"`);
    }

    if (mismatches.length > 0) {
      failures.push(`[${c.id}] "${c.userMessage}"\n    ${mismatches.join('\n    ')}`);
    }

    await sleep(DELAY_MS);
  }

  assert.equal(
    failures.length, 0,
    `${failures.length}/${fixtures.length} golden cases failed:\n\n${failures.join('\n\n')}`,
  );
});
