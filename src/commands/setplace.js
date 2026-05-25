import { geocode, GeocodeNotFoundError } from '../utils/geocode.js';
import { dbSetPlace, dbGetSavedPlaces } from '../db.js';

// Handles both the NLP path (handleSetPlace) and the /setplace slash command.
// userId: in group chats, saved places are stored per user (msg.from.id) so each
// person's "home" and "work" follow them across private and group conversations.
export async function handleSetPlace(bot, chatId, placeName, addressStr, userId = null) {
  const dbId = userId ?? chatId;
  const name = placeName.toLowerCase().trim();

  let result;
  try {
    result = await geocode(addressStr.trim());
  } catch (err) {
    if (err instanceof GeocodeNotFoundError) {
      await bot.sendMessage(chatId, err.message);
    } else {
      console.error('setplace geocode error:', err.message);
      await bot.sendMessage(chatId, 'Something went wrong looking up that address. Try again in a moment.');
    }
    return;
  }

  dbSetPlace(dbId, name, result.formatted);
  await bot.sendMessage(
    chatId,
    `Got it. "${name}" saved as: ${result.formatted}\n\nYou can now say things like "I'm done at work, heading home" and I'll know where to check.`
  );
}

// Register /setplace <name> <address>
// Example: /setplace home Seresponda Court, Kiambu Road
export function registerSetPlace(bot) {
  bot.onText(/^\/setplace\s+(\S+)\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
      await handleSetPlace(bot, chatId, match[1], match[2]);
    } catch (err) {
      console.error('setplace handler error:', err.message);
    }
  });
}

// Register /places — list all saved places for this chat
export function registerListPlaces(bot) {
  bot.onText(/^\/places$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const places = dbGetSavedPlaces(chatId);
      const entries = Object.entries(places);
      if (!entries.length) {
        await bot.sendMessage(
          chatId,
          'No saved places yet. Add one with:\n/setplace home <address>\n/setplace work <address>'
        );
        return;
      }
      const lines = entries.map(([name, addr]) => `${name}: ${addr}`);
      await bot.sendMessage(chatId, `Your saved places:\n\n${lines.join('\n')}`);
    } catch (err) {
      console.error('places handler error:', err.message);
    }
  });
}
