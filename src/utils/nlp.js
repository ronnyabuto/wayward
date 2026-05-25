// Regex pre-filter: classifies unambiguous messages before touching Gemini.
// Returns { command, origin, destination, route_number } or null when uncertain.
// Handles the ~60% of messages that follow simple "X to Y" patterns.
// Saved-place aliases ("home", "work") are intentionally NOT resolved here —
// those go through Gemini which has the saved-places context.
export function quickClassify(text) {
  const t = text.trim();

  // "matatu / mat [from] X to Y"  or  "Route 23 matatu"  or  "no. 23"
  const matatuRoute = t.match(/\b(?:route\s*|no\.?\s*)(\d+)\b/i);
  if (matatuRoute) {
    return { command: 'matatu', origin: null, destination: null, route_number: matatuRoute[1] };
  }

  const isMatatuQuery = /\bmat(?:atu)?\b/i.test(t);
  const isCheckQuery  = /\b(?:traffic|how.?long|how.?far|how.?is|drive|commute)\b/i.test(t);

  // "X to Y [traffic|matatu|driving|now]" — extract origin and destination.
  // Strips leading "matatu/mat/from/how long from" so they don't bleed into origin.
  const routeMatch = t.match(
    /^(?:how.+?from\s+|mat(?:atu)?\s+|from\s+)?(.+?)\s+to\s+(.+?)(?:\s+(?:traffic|matatu|mat|now|right\s*now|driving|via.*)?)?$/i
  );
  if (routeMatch) {
    const [, rawOrigin, rawDest] = routeMatch;
    const origin      = rawOrigin.trim();
    const destination = rawDest.trim();

    // Reject vague pronouns, saved-place aliases, or fragments too short to geocode.
    const VAGUE     = /\b(here|there|get\s+there|from\s+here|from\s+there|it|that)\b/i;
    const ALIAS     = /^(home|work|office|school|me|us)$/i;
    if (origin.length < 2 || destination.length < 2) return null;
    if (VAGUE.test(origin) || VAGUE.test(destination))  return null;
    if (ALIAS.test(origin) || ALIAS.test(destination))  return null;
    // Reject sentence fragments: "I want to X" splits as origin="I want", dest="X…".
    if (/^(?:i\b|you\b|we\b|they\b)/i.test(origin)) return null;
    // Reject if destination is a sentence ending in a question or exclamation.
    if (/[?!]/.test(destination)) return null;

    if (isMatatuQuery) {
      return { command: 'matatu', origin, destination, route_number: null };
    }
    if (isCheckQuery || /\bto\b/.test(t)) {
      return { command: 'check', origin, destination, route_number: null };
    }
  }

  return null;
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
  required: ['command', 'origin', 'destination', 'threshold', 'arrive_by', 'place_name', 'place_address', 'route_number', 'clarification'],
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
  "clarification": "<string | null>"
}

Commands:
- "check": one-time traffic query. User wants to know how long the drive is right now. Use when they ask how traffic is or how long a drive takes, with no stated arrival deadline (e.g. "how's traffic to town?", "how long is the drive to Karen?", "when should I leave in the next 20 min" — that last one is a departure window, not a deadline).
- "watch": persistent alert. User wants to be notified when a specific route drops below a travel-time threshold they name explicitly (e.g. "tell me when it's under 40 min", "alert me when I can get there in less than an hour"). threshold is the target travel time in minutes — NOT a departure window.
- "depart": smart departure advisor. Use when the user wants to know when to leave — either because they're ready now, or because they have an arrival deadline. Covers:
  (a) Ready to leave: "I'm done with work", "heading home", "leaving soon", "is traffic bad now?", "should I go now?"
  (b) Arrival deadline: "I want to be at X before 6pm", "I need to be seated by 7", "I have a 9am meeting", "will I make it by 8 if I leave now?", "when should I leave to arrive before X?"
  Set arrive_by to the deadline (HH:MM 24-hour) when the user states one; null for case (a).
- "setplace": user is saving a location. Use when they declare where their home, work, or any named place is (e.g. "my home is at X", "save my work as Y", "I live in Z").
- "scenic": user wants the most scenic driving route between two places.
- "matatu": user is asking about public transit / matatu conditions on a road corridor. Use when they mention "matatu", "mat", "route [number]", "stage", or ask about public transport. Set route_number if they specify one (e.g., "Route 23" → "23"); set origin/destination if they name the corridor; set both if possible.
- "unknown": cannot confidently determine intent or locations. Set clarification to a short, specific question.

Resolving saved locations:
- If the user says "home", "work", or any saved place name, resolve it to the address from their saved locations list below.
- If they reference a saved place that isn't in the list, set command to "unknown" and clarification to e.g. "You haven't saved a home location yet. What's your home address? (or use /setplace home <address>)"

Key distinctions:
- "when should I leave in the next 20 min" → "check" (20 min is a departure window, not an arrival deadline)
- "tell me when it drops under 20 min" → "watch" with threshold 20
- "I'm done at work, heading home" → "depart" with arrive_by null
- "I want to be at Geco before 6pm" → "depart" with arrive_by "18:00"
- "I need to be at work by 9" → "depart" with arrive_by "09:00"
- "will I make it to JKIA by 8?" → "depart" with arrive_by "08:00"
- "I need to get there in the next 45 minutes" → "depart" with arrive_by = current time + 45 min as HH:MM
- "my home is at Seresponda Court" → "setplace" with place_name "home" and place_address "Seresponda Court"

Other rules:
- origin and destination: most precise, correctly spelled place names including neighbourhood and city (e.g. "Seresponda Court, Kileleshwa, Nairobi, Kenya"). Never invent a place.
- threshold: only for "watch". Between 1 and 300. If user says "by 7am", subtract current time; if result ≤ 0 or > 300, return "unknown".
- arrive_by: only for "depart" when the user names an arrival time or deadline. Rules:
  - AM/PM ambiguity: if no am/pm is stated, infer the next upcoming occurrence from current time. "by 7" at 6 PM → "19:00". "by 7" at 6 AM → "07:00". "by 7" at 11 PM → "07:00" (next morning, but still return "07:00").
  - Relative deadlines: convert to absolute HH:MM using current local time. "in 45 minutes" at 17:10 → "17:55". "within the hour" at 16:40 → "17:40".
  - Return null for arrive_by on all non-depart commands, and for depart when no deadline is stated.
- For all other commands, threshold and arrive_by must be null.
- route_number is only set for "matatu"; null for all other commands.
- Do not add any text outside the JSON object. No markdown, no explanation.

Conversation context:
- You may receive a history of prior turns. Use it to resolve references: "what about from Westlands instead?" carries the previous destination forward with a new origin; "that route" uses the last origin/destination pair; "same time" reuses the previous threshold.
- When the user changes only one location ("go to X instead", "from Y instead"), carry the unchanged location forward from the prior turn exactly as it appeared — do not ask about it again.
- Always produce complete, unambiguous origin and destination values in your output for routing commands.
- Do NOT carry forward pronouns ("there", "it", "that place") or unresolved saved-place aliases — resolve them fully or return unknown.
- If one location is already known from context and the other is ambiguous or unrecognisable, return unknown and ask specifically about the ambiguous location only. Do not claim ignorance of the location you already have from context.`;

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
// Returns { command, origin, destination, threshold, place_name, place_address, clarification }
export async function parseIntent(userMessage, savedPlaces = {}, conversationHistory = []) {
  const now = new Date().toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi',
  });

  const placesLines = Object.entries(savedPlaces)
    .map(([name, addr]) => `  ${name}: ${addr}`)
    .join('\n');
  const placesContext = placesLines
    ? `User's saved locations:\n${placesLines}`
    : `User has no saved locations yet.`;

  const userContent = `${placesContext}\nCurrent local time: ${now}\n\n${userMessage}`;

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
          console.warn(`[Gemini] Key ${i + 1}/${GEMINI_KEYS.length} hit daily quota — rotating to key ${i + 2}.`);
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
