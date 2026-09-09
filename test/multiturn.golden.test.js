// Golden-set regression suite for multi-turn context carry-forward — the bot's
// hardest bug category per commit history (git 9e64aa3, 59ef569, and the
// pending_intents research in memory/research_nlp_memory_architecture.md).
// Calls the real Gemini API — costs quota, not part of the default `npm test` run.
//
//   RUN_GOLDEN_TESTS=1 npm run test:golden
//
// Every "carry forward X" bug fixed in nlp.js should get a permanent fixture here
// instead of a one-off scratch script (see test/fixtures/multiturn.golden.json).
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIntent } from '../src/utils/nlp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const threads = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'multiturn.golden.json'), 'utf8'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = 4500;

const shouldRun = process.env.RUN_GOLDEN_TESTS === '1';

test('multi-turn context carry-forward golden set', { skip: !shouldRun && 'set RUN_GOLDEN_TESTS=1 to run (costs Gemini quota)' }, async () => {
  const failures = [];

  for (const thread of threads) {
    const conversationHistory = [];

    for (const turn of thread.turns) {
      let intent;
      try {
        intent = await parseIntent(turn.userMessage, thread.savedPlaces ?? {}, conversationHistory);
      } catch (err) {
        failures.push(`[${thread.id}] turn "${turn.userMessage}" — parseIntent threw: ${err.message}`);
        await sleep(DELAY_MS);
        continue;
      }

      conversationHistory.push({ userMessage: turn.userMessage, modelResponse: JSON.stringify(intent) });

      if (turn.expect) {
        const mismatches = [];
        const exp = turn.expect;

        if ('command' in exp && intent.command !== exp.command) {
          mismatches.push(`command: expected "${exp.command}", got "${intent.command}"`);
        }
        if ('originIncludes' in exp && !(intent.origin ?? '').toLowerCase().includes(exp.originIncludes.toLowerCase())) {
          mismatches.push(`origin: expected to include "${exp.originIncludes}", got "${intent.origin}"`);
        }
        if ('destinationIncludes' in exp && !(intent.destination ?? '').toLowerCase().includes(exp.destinationIncludes.toLowerCase())) {
          mismatches.push(`destination: expected to include "${exp.destinationIncludes}", got "${intent.destination}"`);
        }

        if (mismatches.length > 0) {
          failures.push(`[${thread.id}] turn "${turn.userMessage}"\n    ${mismatches.join('\n    ')}`);
        }
      }

      await sleep(DELAY_MS);
    }
  }

  assert.equal(
    failures.length, 0,
    `${failures.length} multi-turn assertion(s) failed:\n\n${failures.join('\n\n')}`,
  );
});
