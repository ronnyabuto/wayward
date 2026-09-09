import { logger } from './logger.js';

// Regex pre-filter: classifies unambiguous messages before touching Gemini.
// Returns { command, origin, destination, route_number } or null when uncertain.
//
// Deliberately narrow (2026-09 rewrite): only a bare route number and a
// strict, unprefixed "<origin> to <destination>" shape are handled here. This
// used to also strip various leading words ("how long from", "matatu from",
// "distance from") and reject an ever-growing list of phrasings that broke it
// — seven single-incident regex guards accreted over months, each patched
// after one specific bug report, and still missed cases as basic as "traffic
// from X to Y" bleeding "traffic" into the origin. Anything that needs a
// prefix parsed off, or contains a digit, or opens with a question/pronoun/
// domain word defers to Gemini instead — see the comments on each guard below
// for why each one is a closed category rather than an incident list.
//
// Saved-place aliases ("home", "work") are intentionally NOT resolved here —
// those go through Gemini which has the saved-places context.
export function quickClassify(text) {
  const t = text.trim();

  // Defer to Gemini for any explicit departure-timing question — these need
  // arrive_by extraction (AM/PM disambiguation, relative times, Swahili/Sheng)
  // which only Gemini's schema handles. Never classify locally.
  const DEPART_QUESTION = /\b(?:when\s+should\s+i|what\s+time\s+should\s+i|when\s+do\s+i\s+(?:need\s+to|have\s+to)|niende\s+lini)\b/i;
  if (DEPART_QUESTION.test(t)) return null;

  // "matatu / mat [from] X to Y"  or  "Route 23 matatu"  or  "no. 23" — closed,
  // digit-anchored grammar. This is the only case here that has never needed a
  // fix and never will; it's the one part of this function safe to keep
  // hand-matching indefinitely.
  const matatuRoute = t.match(/\b(?:route\s*|no\.?\s*)(\d+)\b/i);
  if (matatuRoute) {
    return { command: 'matatu', origin: null, destination: null, route_number: matatuRoute[1] };
  }

  // Strict "<origin> to <destination>" match — no leading words are stripped.
  // If the message needs anything parsed off before the origin ("how's traffic
  // from X to Y", "matatu from X to Y", "distance from X to Y"), that's exactly
  // the open-ended free-text parsing this fast path should not attempt; defer
  // to Gemini rather than enumerate every possible prefix.
  //
  // Origin/destination exclude digits by construction. That structurally rules
  // out numeric deadlines ("by 8am", "before 8", "9am meeting") bleeding into
  // either slot — no keyword list per time format needed, because a matched
  // place name literally cannot contain the digit a deadline requires.
  const PLACE = `[a-zA-Z][a-zA-Z' -]{1,40}?`;
  const routeMatch = t.match(new RegExp(
    `^(${PLACE})\\s+to\\s+(${PLACE})(?:\\s+(traffic|matatu|mat|now|right\\s*now|driving))?\\??$`, 'i'
  ));
  if (!routeMatch) return null;

  const origin      = routeMatch[1].trim();
  const destination = routeMatch[2].trim();
  const qualifier   = routeMatch[3];

  // Vague pronouns and saved-place aliases need Gemini's saved-places context,
  // which this function doesn't have.
  const VAGUE = /\b(here|there|get\s+there|from\s+here|from\s+there|it|that)\b/i;
  const ALIAS = /^(home|work|office|school|me|us)$/i;
  if (VAGUE.test(origin) || VAGUE.test(destination)) return null;
  if (ALIAS.test(origin) || ALIAS.test(destination)) return null;

  // A real place name is never a question — English has exactly these WH-words.
  if (/^(?:how|what|when|where|why|who|which)\b/i.test(origin)) return null;

  // A real place name is never one of the bot's own query-type nouns. Bounded
  // by the bot's fixed 6-command vocabulary, not by incident history — this
  // list only grows if the bot itself grows a new command.
  if (/^(?:traffic|distance|directions?|route|drive|driving|commute|matatu|mat)\b/i.test(origin)) return null;

  // A real place name never opens with a pronoun or auxiliary/modal verb — a
  // closed grammatical category, not a per-bug-report list. Catches sentence
  // fragments like "I want to go to X" or "Am going to X".
  if (/^(?:i|you|we|they|am|is|are|was|were|be|been|do|does|did|will|would|can|could|should|shall|must|may|might|have|has|had|want|need|going|trying|planning|heading|looking|leaving|check)\b/i.test(origin)) return null;

  return {
    command: qualifier && /^mat/i.test(qualifier) ? 'matatu' : 'check',
    origin,
    destination,
    route_number: null,
  };
}

// Gemini 3.1 Flash-Lite — natural language → structured intent.
// Every user message passes through here before touching any routing API.
// Gemini corrects misspellings, resolves vague descriptions, infers the command,
// and returns clean place names that Google Maps can geocode without assumptions.
//
// Model: gemini-3.1-flash-lite (stable, GA May 2026).
// Confirmed working on v1beta with systemInstruction, responseMimeType, responseSchema,
// and thinkingConfig — verified by live API call before switching from 2.5-flash-lite.
// v1beta is required; these features are not available on the v1 stable endpoint.
//
// Multi-key rotation: set GEMINI_API_KEY_2 / GEMINI_API_KEY_3 in .env, each from a
// different Google Cloud project. Quota is per-project, not per-key — multiple keys
// in the same project share the same daily pool and rotation won't help.
// On a per-day quota 429, the module permanently advances to the next key for the
// lifetime of the process. A bot restart resets rotation (daily quotas reset at
// midnight Pacific Time, so restarting the next morning works cleanly).

const MODEL = 'gemini-3.1-flash-lite';
const BASE_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Keys are tried in order; keyIndex advances permanently on per-day exhaustion.
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(Boolean);

if (GEMINI_KEYS.length === 0) {
  throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY in .env.');
}

let keyIndex = 0;

// Constrained-decoding schema: Gemini's FSM enforces this at token-generation time,
// making it impossible to emit a value outside the enum or a field of the wrong type.
// All 7 fields are required so intent.command etc. are never undefined — only null.
// Field order matches the system prompt to avoid model confusion (per Gemini docs).
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['command', 'origin', 'destination', 'threshold', 'arrive_by', 'place_name', 'place_address', 'route_number', 'corridor', 'clarification'],
  properties: {
    command: {
      type: 'string',
      enum: ['check', 'watch', 'depart', 'setplace', 'scenic', 'matatu', 'unknown'],
      description: 'The detected command intent.',
    },
    origin: {
      type: 'string',
      nullable: true,
      description: 'Fully-qualified origin place name (neighbourhood, city, country). Null if undetermined.',
    },
    destination: {
      type: 'string',
      nullable: true,
      description: 'Fully-qualified destination place name. Null if undetermined.',
    },
    threshold: {
      type: 'number',
      nullable: true,
      description: 'Travel-time threshold in minutes (1–300). Only for watch; null for all other commands.',
    },
    arrive_by: {
      type: 'string',
      nullable: true,
      description: 'Arrival deadline in HH:MM 24-hour format (e.g. "18:00"). Set only for depart when the user names a specific time they must arrive by. Null for all other commands.',
    },
    place_name: {
      type: 'string',
      nullable: true,
      description: 'Label to save (e.g. "home", "work"). Only for setplace; null for all other commands.',
    },
    place_address: {
      type: 'string',
      nullable: true,
      description: 'Address string to save. Only for setplace; null for all other commands.',
    },
    route_number: {
      type: 'string',
      nullable: true,
      description: 'Matatu route number if user specifies one (e.g., "23", "Route 23"). Only for matatu; null for all other commands.',
    },
    corridor: {
      type: 'string',
      nullable: true,
      description: 'Road or highway corridor name when the user asks about traffic on a specific road (e.g. "Thika Road", "Ngong Road"). Never assign a road or highway name to origin or destination — this field only. Null for all other commands.',
    },
    clarification: {
      type: 'string',
      nullable: true,
      description: 'Short clarifying question when command is unknown or locations are ambiguous.',
    },
  },
};

const SYSTEM_PROMPT = `You are the intent parser for a commuter bot that helps Nairobi commuters decide when to leave and find scenic routes.

Given a user message, their saved locations, and the current local time, return a JSON object with this exact shape:
{
  "command": "check" | "watch" | "depart" | "setplace" | "scenic" | "unknown",
  "origin": "<place name or null>",
  "destination": "<place name or null>",
  "threshold": <number | null>,
  "arrive_by": "<HH:MM or null>",
  "place_name": "<name to save or null>",
  "place_address": "<address to save or null>",
  "corridor": "<road or highway name, or null>",
  "clarification": "<string | null>"
}

Commands:
- "check": one-time traffic query. User wants to know how long the drive is right now. Use when they ask how traffic is or how long a drive takes, with no stated arrival deadline (e.g. "how's traffic to town?", "how long is the drive to Karen?", "when should I leave in the next 20 min" — that last one is a departure window, not a deadline).
- "watch": persistent alert. User wants to be notified when a specific route drops below a travel-time threshold they name explicitly (e.g. "tell me when it's under 40 min", "alert me when I can get there in less than an hour"). threshold is the target travel time in minutes — NOT a departure window.
- "depart": smart departure advisor. Use when the user wants to know when to leave — either because they're ready now, or because they have an arrival deadline. Covers:
  (a) Ready to leave: "I'm done with work", "heading home", "leaving soon", "is traffic bad now?", "should I go now?"
  (b) Arrival deadline: "I want to be at X before 6pm", "I need to be seated by 7", "I have a 9am meeting", "will I make it by 8 if I leave now?", "when should I leave to arrive before X?"
  Set arrive_by to the deadline (HH:MM 24-hour) when the user states one; null for case (a).
- "setplace": user is saving a location. Use ONLY when they explicitly declare a place with words like "my home is", "save my work as", "I live at", "set home to", etc. Do NOT use setplace when the user simply states a location as their current position or as an answer to "where are you leaving from?" — that is an origin for a routing command, not a place to save.
- "scenic": user wants the most scenic driving route between two places.
- "matatu": user is asking about public transit / matatu conditions on a road corridor. Use when they mention "matatu", "mat", "route [number]", "stage", or ask about public transport. Set route_number if they specify one (e.g., "Route 23" → "23"); set origin/destination if they name the corridor; set both if possible.
- "unknown": cannot confidently determine intent or locations. Set clarification to a short, specific question.

Resolving saved locations:
- If the user says "home", "work", or any saved place name, resolve it to the address from their saved locations list below.
- If they reference a saved place that isn't in the list, set command to "unknown" and clarification to e.g. "You haven't saved a home location yet. What's your home address? (or use /setplace home <address>)"

Key distinctions:
- Departure window vs. arrival deadline: "when should I leave in the next 20 min" → "check" — a window ("in the next N min") is not a deadline. Only "by/before <time>" phrasing (or an equivalent stated arrival time) is a deadline.
- Explicit threshold vs. vague notification: "watch" requires a number the user actually stated ("tell me when it drops under 20 min" → watch, threshold 20). A vague request with no number ("tell me when traffic clears", "notify me when it eases") → "depart" with arrive_by null; depart auto-sets its own threshold. Never invent a threshold for watch.
- Notification framing never overrides a stated deadline: verbs like ping/tell/remind/notify/alert describe HOW the user wants the result delivered, not WHETHER a deadline applies. If a deadline is present anywhere in the message, extract arrive_by regardless of how the notification is phrased — e.g. "I have a 9am meeting, ping me when to leave" → depart, arrive_by="09:00". Only when there is no deadline anywhere in the message does notification phrasing alone mean arrive_by=null.
- Back-reference to a just-given result: if the most recent turn was a depart with an arrive_by, and the user replies with a bare acknowledgement of wanting to be notified ("can you ping at that time?", "remind me then", "set that up") with no new deadline or location stated — that converts the standing arrive_by into a watch on the same origin/destination, threshold null. Do not apply this if the current message itself states a new time or deadline. (For the more general case of filling a missing slot or carrying a route forward across turns, see Conversation context below — this rule is specifically about converting a result into a notification request, which that section doesn't cover.)

Other rules:
- origin and destination: Output in the format "<POI or address>, <neighbourhood>, <city>, Kenya". Always include city and country. Omit neighbourhood only if unknown. No abbreviations, no trailing punctuation. Examples: "Sarit Centre, Westlands, Nairobi, Kenya"; "JKIA, Embakasi, Nairobi, Kenya"; "Garden City Mall, Thika Road, Nairobi, Kenya"; "Mombasa CBD, Mombasa, Kenya". Never invent a place.
- threshold: only for "watch". Between 1 and 300. If user says "by 7am", subtract current time; if result ≤ 0 or > 300, return "unknown".
- arrive_by: only for "depart" when the user names an arrival time or deadline. Rules:
  - AM/PM ambiguity: if no am/pm is stated, infer the next upcoming occurrence from current time. "by 7" at 6 PM → "19:00". "by 7" at 6 AM → "07:00". "by 7" at 11 PM → "07:00" (next morning, but still return "07:00").
  - Relative deadlines: convert to absolute HH:MM using current local time. "in 45 minutes" at 17:10 → "17:55". "within the hour" at 16:40 → "17:40".
  - Return null for arrive_by on all non-depart commands, and for depart when no deadline is stated.
- For all other commands, threshold and arrive_by must be null.
- Road and highway names (e.g. Thika Road, Ngong Road, Mombasa Road, Waiyaki Way, Langata Road, Uhuru Highway, Jogoo Road, Eastern Bypass, Southern Bypass, Northern Bypass) identify a corridor — not an origin or destination. When the user says "how is [road] from X to Y", set origin=X and destination=Y. The road name belongs in corridor only. Never assign a road or highway name to origin or destination. Example: "how thika road looking right now from kahawa sukari to cbd?" → check, origin="Kahawa Sukari, Nairobi, Kenya", destination="Nairobi CBD, Kenya", corridor="Thika Road".
- route_number is only set for "matatu"; null for all other commands.
- Messages may be in English, Swahili, or Sheng (Nairobi street slang). Extract intent and place names regardless of language. Key terms: 'nataka kwenda'/'naenda' = going to, 'town' = Nairobi CBD, 'stage' = matatu terminus, 'mbaya' = bad/heavy traffic, 'safi' = clear/good.
- Do not add any text outside the JSON object. No markdown, no explanation.

Conversation context:
- Prior model turns contain JSON intent objects. Only carry route context forward when the current message has routing intent — it mentions travel, traffic, commute, departure, arrival, leaving, heading, driving, or asks about getting somewhere. If the message is off-topic (asking about time, news, weather, general questions unrelated to commuting), return "unknown" with a brief clarification; do NOT apply a prior route to it. When routing intent IS present and explicit location names are absent, read origin and destination from the most recent prior model turn's JSON to carry them forward. For example, if the prior model turn contains "origin":"Sarit Centre, Westlands, Nairobi, Kenya" and the current message is "when should I leave?", use that origin.
- You may receive a history of prior turns. Use it to resolve references: "what about from Westlands instead?" carries the previous destination forward with a new origin; "that route" uses the last origin/destination pair; "same time" reuses the previous threshold.
- When the user changes only one location ("go to X instead", "from Y instead"), carry the unchanged location forward from the prior turn exactly as it appeared — do not ask about it again.
- Always produce complete, unambiguous origin and destination values in your output for routing commands.
- Do NOT carry forward pronouns ("there", "it", "that place") or unresolved saved-place aliases — resolve them fully or return unknown.
- If one location is already known from context and the other is ambiguous or unrecognisable, return unknown and ask specifically about the ambiguous location only. Do not claim ignorance of the location you already have from context.
- If the prior turn was a routing command (check/depart/watch) with a null origin or destination, and the user's current message is just a location name or address, treat it as filling in the missing field for that same command. Do NOT classify it as setplace.`;

// Parse the quota error body to distinguish per-minute vs per-day exhaustion and
// extract the retry delay. Using quotaId is reliable — the API returns ~60s retryDelay
// for BOTH RPM and RPD failures, so delay duration alone cannot distinguish them.
function parseQuotaError(text) {
  let retryDelaySec = 0;
  let isPerDay = false;
  try {
    const errJson = JSON.parse(text);
    const retryInfo = errJson.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
    if (retryInfo?.retryDelay) retryDelaySec = parseInt(retryInfo.retryDelay, 10);
    const quota = errJson.error?.details?.find(d => d['@type']?.includes('QuotaFailure'));
    isPerDay = quota?.violations?.some(v => v.quotaId?.toLowerCase().includes('perday')) ?? false;
  } catch { /* malformed error body — treat as unknown */ }
  return { retryDelaySec, isPerDay };
}

function fetchOnce(key, body) {
  return fetch(`${BASE_ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// savedPlaces:         { home: 'Seresponda Court, Nairobi', work: 'Westlands, Nairobi' }
// conversationHistory: [{ userMessage, modelResponse }, ...] — last N turns, oldest first
// activeFacts:         [{ subject, predicate, object }, ...] — long-term user facts from user_facts table
// Returns { command, origin, destination, threshold, place_name, place_address, clarification }
export async function parseIntent(userMessage, savedPlaces = {}, conversationHistory = [], activeFacts = []) {
  const now = new Date().toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi',
  });

  const placesLines = Object.entries(savedPlaces)
    .map(([name, addr]) => `  ${name}: ${addr}`)
    .join('\n');
  const placesContext = placesLines
    ? `User's saved locations:\n${placesLines}`
    : `User has no saved locations yet.`;

  const factsContext = activeFacts.length > 0
    ? `Known facts about this user:\n${activeFacts.map(f => `  ${f.subject} ${f.predicate} ${f.object}`).join('\n')}`
    : '';

  // If the most recent turn had a known route, surface it explicitly in the user content
  // so the model doesn't have to parse JSON from its own prior turns (unreliable at thinkingBudget:0).
  // Only inject when the current message has routing intent — prevents off-topic messages
  // ("what time is it?", greetings, etc.) from inheriting a route and triggering a traffic check.
  const hasRoutingIntent = /\b(traffic|drive|driving|leave|leaving|head(?:ing)?|go(?:ing)?|commute|arriv|depart|get\s+to|from|road|route|travel|when\s+should|how\s+long|how\s+far|minute|min\b|jam|stuck|ping|remind|alert|notify|watch|check)\b/i.test(userMessage);
  let lastRoute = null;
  if (hasRoutingIntent) {
    for (let j = conversationHistory.length - 1; j >= 0; j--) {
      try {
        const prev = JSON.parse(conversationHistory[j].modelResponse);
        if (prev.origin || prev.destination) {
          lastRoute = { origin: prev.origin, destination: prev.destination };
          break;
        }
      } catch { /* skip malformed */ }
    }
  }
  const routeCtx = lastRoute
    ? `\nMost recent route from context: origin="${lastRoute.origin ?? 'unknown'}", destination="${lastRoute.destination ?? 'unknown'}".`
    : '';

  const userContent = [placesContext, factsContext, `Current local time: ${now}${routeCtx}`, userMessage]
    .filter(Boolean).join('\n\n');

  // Build multi-turn contents: prior turns first, then the current message.
  // Model turns store the raw JSON string so Gemini can resolve forward references.
  const historyContents = conversationHistory.flatMap(turn => [
    { role: 'user',  parts: [{ text: turn.userMessage  }] },
    { role: 'model', parts: [{ text: turn.modelResponse }] },
  ]);

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      ...historyContents,
      { role: 'user', parts: [{ text: userContent }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      // Thinking adds latency with no quality benefit for temperature-0 schema-constrained
      // extraction. Disable explicitly — 3.1 Flash-Lite enables thinking by default.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  // Key rotation: if keyIndex has already advanced past all keys (all exhausted), fail fast.
  if (keyIndex >= GEMINI_KEYS.length) {
    throw new Error('All Gemini API keys have exhausted their daily quota. Restart the bot after midnight Pacific Time to reset.');
  }

  // Try each key starting from the current keyIndex.
  // - Per-day 429: advance keyIndex permanently and try the next key.
  // - Per-minute 429: wait for the rate window to reset (~60s), retry same key.
  // - 503 (server overload): wait 5s, retry same key.
  for (let i = keyIndex; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[i];

    let res = await fetchOnce(key, body);

    if (res.status === 429) {
      const errText = await res.text();
      const { retryDelaySec, isPerDay } = parseQuotaError(errText);

      if (isPerDay) {
        keyIndex = i + 1;
        if (i < GEMINI_KEYS.length - 1) {
          logger.warn({ keyIndex: i + 1, total: GEMINI_KEYS.length }, 'Gemini key hit daily quota — rotating');
          continue;
        }
        throw new Error(`All ${GEMINI_KEYS.length} Gemini key(s) have exhausted their daily quota.`);
      }

      if (retryDelaySec > 0 && retryDelaySec <= 75) {
        await new Promise(r => setTimeout(r, retryDelaySec * 1000 + 500));
        res = await fetchOnce(key, body);
      } else {
        throw new Error(`Gemini API 429: ${errText}`);
      }
    }

    if (res.status === 503) {
      await new Promise(r => setTimeout(r, 5000));
      res = await fetchOnce(key, body);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API ${res.status}: ${text}`);
    }

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini returned no content');

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
}
