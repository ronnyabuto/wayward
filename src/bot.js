import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { logger } from './utils/logger.js';
import { registerStopwatch, registerListWatches, handleWatch, commitWatch } from './commands/watch.js';
import { handleScenic } from './commands/scenic.js';
import { handleCheck } from './commands/check.js';
import { handleDepart } from './commands/depart.js';
import { handleMatatu } from './commands/matatu.js';
import { handleSetPlace, registerSetPlace, registerListPlaces, geocodePlace } from './commands/setplace.js';
import { startScheduler, loadWatchesFromDb, loadScheduledPendingIntents } from './scheduler.js';
import { parseIntent, quickClassify } from './utils/nlp.js';
import { initDb, dbGetSavedPlaces, dbSetPlace, dbPersistTurn, dbRetrieveRelevantTurns,
         dbGetActivePendingIntent, dbDeletePendingIntent } from './db.js';

const { TELEGRAM_BOT_TOKEN } = process.env;


if (!TELEGRAM_BOT_TOKEN) {
  logger.fatal('Missing TELEGRAM_BOT_TOKEN. Copy .env.example → .env and fill it in.');
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
loadScheduledPendingIntents(bot);

// Pending setplace confirmations keyed by userId.
// Volatile — cleared on restart; the user just resends if that happens.
const pendingSetPlace = new Map();

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
    // Confirmation gate: if this user has a pending setplace, resolve it first.
    const pending = pendingSetPlace.get(userId);
    if (pending) {
      const reply = text.toLowerCase().trim();
      pendingSetPlace.delete(userId);
      if (/^(yes|yeah|yep|sure|ok|okay|confirm|y)$/.test(reply)) {
        dbSetPlace(userId, pending.placeName, pending.formattedAddress);
        await bot.sendMessage(
          chatId,
          `Got it. "${pending.placeName}" saved as: ${pending.formattedAddress}\n\nYou can now say things like "I'm done at work, heading home" and I'll know where to check.`
        );
        return;
      }
      if (/^(no|nope|cancel|nah|n)$/.test(reply)) {
        await bot.sendMessage(chatId, 'Cancelled.');
        return;
      }
      // Any other reply: treat as a new message (fall through to NLP path below).
    }

    // Pending intent gate: resolve "can you ping me?" / "remind me" follow-ups
    // without re-running the full NLP pipeline.
    const pendingIntent = dbGetActivePendingIntent(userId);
    if (pendingIntent) {
      // A confirmation is short and has no routing structure.
      // "tell me when to leave" embeds confirmation words in a new routing query —
      // checking word count + routing verb + "to" pattern catches this.
      const words = text.split(/\s+/).length;
      const hasRoutingStructure = /\b(go|going|heading|drive|traffic|watch|check|monitor|want\s+to|need\s+to|take\s+me)\b.{0,60}\bto\b/i.test(text);
      const isConfirmation = words <= 10 && !hasRoutingStructure &&
        /\b(ping|alert|remind|notify|tell\s*me|message\s*me|yes|yeah|sure|ok|okay|do\s*(that|it)|set\s*(that|it)\s*up)\b/i.test(text);

      if (pendingIntent.intent_type === 'scheduled_watch' && isConfirmation) {
        const timeStr = new Date(pendingIntent.fire_at * 1000)
          .toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Nairobi' })
          .replace(/^00:/, '12:');
        await bot.sendMessage(chatId, `Already on it — I'll start watching at ${timeStr} and ping you when it's time to leave.`);
        dbPersistTurn(userId, chatId, text, JSON.stringify({ command: 'watch', origin: pendingIntent.origin, destination: pendingIntent.destination, threshold: pendingIntent.threshold_min }));
        return;
      }

      if (pendingIntent.intent_type === 'watch_offer') {
        if (isConfirmation) {
          dbDeletePendingIntent(pendingIntent.id);
          commitWatch(chatId, pendingIntent.origin, pendingIntent.destination, pendingIntent.threshold_min, pendingIntent.origin_place_id ?? null, pendingIntent.dest_place_id ?? null);
          const oShort = pendingIntent.origin.split(',')[0];
          const dShort = pendingIntent.destination.split(',')[0];
          await bot.sendMessage(chatId, `Watch set. I'll message you when ${oShort} → ${dShort} drops under ${pendingIntent.threshold_min} min.`);
          dbPersistTurn(userId, chatId, text, JSON.stringify({ command: 'watch', origin: pendingIntent.origin, destination: pendingIntent.destination, threshold: pendingIntent.threshold_min }));
          return;
        }
        // User moved on to something else — clear the stale offer before continuing.
        dbDeletePendingIntent(pendingIntent.id);
      }
    }

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
      logger.error({ err, chatId }, 'Gemini intent parse error');
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
      const formatted = await geocodePlace(bot, chatId, intent.place_address);
      if (!formatted) return;
      const name = intent.place_name.toLowerCase().trim();
      pendingSetPlace.set(userId, { placeName: name, formattedAddress: formatted });
      await bot.sendMessage(chatId, `Save "${name}" as: ${formatted}? Reply yes to confirm or no to cancel.`);
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

    // Warn once if the user asked for a waypoint — routing via intermediate stops
    // isn't supported; show the direct result and let them know.
    if (/\bvia\b/i.test(text) && ['check', 'depart'].includes(intent.command)) {
      await bot.sendMessage(chatId, "I can't route via a specific waypoint yet — showing you the fastest direct options.");
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
        // No explicit threshold: "tell me when traffic clears" is depart semantics —
        // handleDepart auto-sets the threshold at ceil(typicalMin * 1.2) and watches
        // until it's met. Only fall back to asking if we have no locations either.
        if (intent.origin && intent.destination) {
          await handleDepart(bot, chatId, intent.origin, intent.destination, null, userId);
          return;
        }
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
    logger.error({ err, chatId: msg?.chat?.id }, 'message handler error');
  }
});

bot.on('polling_error', (err) => {
  logger.error({ err }, 'Telegram polling error');
});

logger.info('Wayward is running.');
