// Group chats share one chatId across every member — any state that must stay
// private per person (saved places, personal traffic history, user_facts) has
// to be keyed by the sender's own Telegram user id instead, or it leaks across
// the whole group. Centralized here after a bug where the /setplace and
// /places slash-command handlers computed this inline and got it wrong: they
// used chatId unconditionally, so in a group, one member's home/work address
// was saved to (and visible to anyone via /places from) the shared group
// bucket instead of that member's own private one.
export function resolveUserId(msg) {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const userId = isGroup ? (msg.from?.id ?? chatId) : chatId;
  return { chatId, userId, isGroup };
}
