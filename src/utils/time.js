// Nairobi is UTC+3, no daylight saving time. Offset is always exactly 3 hours.
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatHour(h) {
  if (h === 0)  return '12am';
  if (h < 12)   return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

export function getNairobiComponents(date = new Date()) {
  const d = new Date(date.getTime() + NAIROBI_OFFSET_MS);
  return {
    dayOfWeek: d.getUTCDay(),     // 0 = Sunday, 6 = Saturday
    hourOfDay: d.getUTCHours(),   // 0–23
    dayName:   DAY_NAMES[d.getUTCDay()],
    hourStr:   formatHour(d.getUTCHours()),
  };
}
