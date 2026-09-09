/**
 * End-to-end deadline multi-turn harness for Wayward.
 * Verifies the edge case: "what time should I be leaving Palace Apartments in Limuru Road to get to Burn Manufacturing in Westlands by 8.10am?"
 */
import 'dotenv/config';
import { parseIntent, quickClassify } from './src/utils/nlp.js';
import { handleDepart } from './src/commands/depart.js';
import { dbSetPlace, initDb } from './src/db.js';

const TEST_CHAT = 7777777;
const TEST_USER = 7777777;

initDb();

const sent = [];
const mockBot = {
  sendMessage: async (chatId, text) => {
    sent.push({ chatId, text: text.replace(/\n/g, ' ↵ ') });
    return { message_id: Date.now() };
  },
};
function lastMsg()  { return sent[sent.length - 1]?.text ?? '(no message)'; }
function clearMsgs() { sent.length = 0; }

async function run() {
  console.log("── Testing quickClassify ───────────────────────");
  const msg = "what time should I be leaving Palace Apartments in Limuru Road to get to Burn Manufacturing in Westlands by 8.10am?";
  const q = quickClassify(msg);
  console.log("quickClassify returned:", q);

  console.log("\n── Testing parseIntent ─────────────────────────");
  try {
    const intent = await parseIntent(msg, {}, []);
    console.log("parseIntent returned:", intent);
    if (intent.command !== 'depart') {
      console.error("❌ Expected 'depart', got", intent.command);
    } else {
      console.log("✅ correctly identified as depart");
    }
  } catch (err) {
    console.error("❌ parseIntent error:", err);
  }

  console.log("\n── Testing full multi-turn handleDepart ────────");
  
  dbSetPlace(TEST_CHAT, 'home', 'Palace Apartments, Limuru Road, Nairobi, Kenya');
  dbSetPlace(TEST_CHAT, 'work', 'Burn Manufacturing, Westlands, Nairobi, Kenya');
  
  const msg1 = "what time should I be leaving home to get to work by 8.10am?";
  console.log("User:", msg1);
  const intent1 = await parseIntent(msg1, { home: 'Palace Apartments, Limuru Road, Nairobi, Kenya', work: 'Burn Manufacturing, Westlands, Nairobi, Kenya' }, []);
  console.log("Intent 1:", intent1);
  
  clearMsgs();
  if (intent1.command === 'depart') {
    await handleDepart(mockBot, TEST_CHAT, intent1.origin, intent1.destination, intent1.arrive_by, TEST_USER);
    console.log("Bot:", lastMsg());
  }

  const msg2 = "what about if I want to arrive by 9am instead?";
  console.log("\nUser:", msg2);
  const intent2 = await parseIntent(msg2, { home: 'Palace Apartments, Limuru Road, Nairobi, Kenya', work: 'Burn Manufacturing, Westlands, Nairobi, Kenya' }, [
    { userMessage: msg1, modelResponse: JSON.stringify(intent1) }
  ]);
  console.log("Intent 2:", intent2);

  clearMsgs();
  if (intent2.command === 'depart') {
    await handleDepart(mockBot, TEST_CHAT, intent2.origin, intent2.destination, intent2.arrive_by, TEST_USER);
    console.log("Bot:", lastMsg());
  }
}

run().catch(console.error);
