// parseIntent's retry policy, against a stubbed fetch — no network, no quota.
// Run with `npm test`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
const { parseIntent } = await import('../src/utils/nlp.js');

const INTENT = { command: 'unknown', clarification: 'Where is "cod"?' };
const ok = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(INTENT) }] } }],
}), { status: 200 });
const status = (code) => new Response('{"error":{}}', { status: code });

const realFetch = globalThis.fetch;
let calls;
function stubFetch(...responses) {
  calls = 0;
  globalThis.fetch = async () => {
    const next = responses[Math.min(calls++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  };
}
beforeEach(() => { calls = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

test('network failure (fetch rejects) is retried, not surfaced to the user', async () => {
  stubFetch(new TypeError('fetch failed'), ok);
  assert.deepEqual(await parseIntent('When should I leave cod to go to kahawa downs?'), INTENT);
  assert.equal(calls, 2);
});

test('5xx is retried', async () => {
  stubFetch(() => status(500), () => status(503), ok);
  assert.deepEqual(await parseIntent('x'), INTENT);
  assert.equal(calls, 3);
});

test('non-transient status fails immediately without retrying', async () => {
  stubFetch(() => status(400), ok);
  await assert.rejects(parseIntent('x'), /Gemini API 400/);
  assert.equal(calls, 1);
});
