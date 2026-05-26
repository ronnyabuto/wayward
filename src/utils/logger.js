import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid },
  // Never log raw API keys even if they accidentally appear in an object
  redact: ['*.key', '*.apiKey', '*.GOOGLE_API_KEY', '*.GEMINI_API_KEY'],
});
