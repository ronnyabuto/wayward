import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { registerStopwatch, registerListWatches, handleWatch } from './commands/watch.js';
import { handleScenic } from './commands/scenic.js';
import { handleCheck } from './commands/check.js';
import { handleDepart } from './commands/depart.js';
import { handleMatatu } from './commands/matatu.js';
import { handleSetPlace, registerSetPlace, registerListPlaces } from './commands/setplace.js';
import { startScheduler, loadWatchesFromDb } from './scheduler.js';
import { parseIntent, quickClassify } from './utils/nlp.js';
import { initDb, dbGetSavedPlaces, dbPersistTurn, dbRetrieveRelevantTurns } from './db.js';

const { TELEGRAM_BOT_TOKEN } = process.env;


if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

initDb();
loadWatchesFromDb();

// family: 4 forces IPv4 at the socket level — needed because this machine has no
// working IPv6 route and @cypress/request's AggregateError handling kills both
// attempts when IPv6 fails, even when DNS returns IPv4 first.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: { agentOptions: { family: 4 } },
});

registerStopwatch(bot);
registerListWatches(bot);
registerSetPlace(bot);
registerListPlaces(bot);
startScheduler(bot);

// Free-form messages — anything that didn't match an explicit /command.
bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // In groups: personal data (saved places, traffic history, personal baselines)
  // is keyed by the individual user so it follows them across private and group chats.
  // Notifications (watches, responses) go to chatId — the group in group context.
  const userId = isGroup ? (msg.from?.id ?? chatId) : chatId;

  try {
    // Layer 1: regex pre-filter — handles unambiguous "X to Y" patterns without
    // spending a Gemini request. Falls through to Gemini when uncertain.
    const quick = quickClassify(text);

    if (quick && quick.command === 'check' && quick.origin && quick.destination) {
      await handleCheck(bot, chatId, quick.origin, quick.destination, userId);
      dbPersistTurn(userId, chatId, text, JSON.stringify(quick));
      return;
    }

    if (quick && quick.command === 'matatu') {
      if (quick.origin && quick.destination) {
        await handleMatatu(bot, chatId, quick.origin, quick.destination);
        dbPersistTurn(userId, chatId, text, JSON.stringify(quick));
        return;
      }
      // Has route_number but no corridor — fall through to Gemini to extract location context.
    }

    // Layer 2: Gemini — handles saved-place resolution, context carry-forward,
    // arrive_by extraction, and any pattern the regex doesn't catch.
    const savedPlaces = dbGetSavedPlaces(userId);
    const history     = dbRetrieveRelevantTurns(userId, text);

    let intent;
    try {
      intent = await parseIntent(text, savedPlaces, history);
    } catch (err) {
      console.error('Gemini error:', err.message);
      await bot.sendMessage(chatId, 'Something went wrong understanding that. Try again in a moment.');
      return;
    }

    dbPersistTurn(userId, chatId, text, JSON.stringify(intent));

    if (intent.command === 'unknown') {
      await bot.sendMessage(
        chatId,
        intent.clarification ?? `I didn't quite catch that. Try: "I'm heading home from work" or "matatu CBD to Westlands".`
      );
      return;
    }

    if (intent.command === 'setplace') {
      await handleSetPlace(bot, chatId, intent.place_name, intent.place_address, userId);
      return;
    }

    // Guard: routing commands need locations. matatu can proceed with route_number
    // alone — the handler will ask for the corridor if needed.
    const needsRoute = ['check', 'depart', 'watch', 'scenic'].includes(intent.command);
    if (needsRoute && (!intent.origin || !intent.destination)) {
      await bot.sendMessage(
        chatId,
        intent.clarification ?? "I need both a starting point and a destination. Could you be more specific?"
      );
      return;
    }

    if (intent.command === 'matatu') {
      if (!intent.origin && !intent.destination && !intent.route_number) {
        await bot.sendMessage(chatId, "Which corridor do you want to check? (e.g. \"matatu CBD to Westlands\" or \"Route 23\")");
        return;
      }
      if (intent.route_number && (!intent.origin || !intent.destination)) {
        await bot.sendMessage(
          chatId,
          `I don't have route data for Route ${intent.route_number} yet. Which corridor does it run? (e.g. "Route ${intent.route_number} CBD to Westlands")`
        );
        return;
      }
      await handleMatatu(bot, chatId, intent.origin, intent.destination);
      return;
    }

    if (intent.command === 'check') {
      await handleCheck(bot, chatId, intent.origin, intent.destination, userId);
      return;
    }

    if (intent.command === 'depart') {
      await handleDepart(bot, chatId, intent.origin, intent.destination, intent.arrive_by ?? null, userId);
      return;
    }

    if (intent.command === 'watch') {
      const t = intent.threshold;
      if (!t || t < 1 || t > 300) {
        await bot.sendMessage(chatId, 'Got it — what travel time are you aiming for? (e.g. "alert me when it\'s under 40 min")');
        return;
      }
      await handleWatch(bot, chatId, intent.origin, intent.destination, t);
      return;
    }

    if (intent.command === 'scenic') {
      await handleScenic(bot, chatId, intent.origin, intent.destination);
    }
  } catch (err) {
    console.error('Message handler error:', err.message);
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Wayward is running.');
