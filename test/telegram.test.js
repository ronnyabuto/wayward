// Regression test for resolveUserId — the group-chat privacy leak fix.
// Bug: /setplace and /places computed chatId/userId inline and got it wrong,
// using the group's shared chatId unconditionally. One member's home/work
// address ended up saved to (and visible to anyone via /places from) the
// whole group's shared bucket instead of that member's own private one.
// Every place in the codebase that needs the sender's private key must now
// go through this one function — this test is what should catch it if a
// future handler drifts back to inline chatId/isGroup logic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserId } from '../src/utils/telegram.js';

describe('resolveUserId', () => {
  test('private chat — userId equals chatId', () => {
    const msg = { chat: { id: 555, type: 'private' }, from: { id: 555 } };
    assert.deepEqual(resolveUserId(msg), { chatId: 555, userId: 555, isGroup: false });
  });

  test('group chat — userId is the sender, distinct from the shared chatId', () => {
    const msg = { chat: { id: -100123, type: 'group' }, from: { id: 42 } };
    assert.deepEqual(resolveUserId(msg), { chatId: -100123, userId: 42, isGroup: true });
  });

  test('supergroup — same per-user resolution as group', () => {
    const msg = { chat: { id: -100999, type: 'supergroup' }, from: { id: 7 } };
    assert.deepEqual(resolveUserId(msg), { chatId: -100999, userId: 7, isGroup: true });
  });

  test('group chat with no from field — falls back to chatId, never crashes', () => {
    const msg = { chat: { id: -100123, type: 'group' } };
    assert.deepEqual(resolveUserId(msg), { chatId: -100123, userId: -100123, isGroup: true });
  });
});
