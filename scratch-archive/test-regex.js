const DEPART_QUESTION = /\b(?:when\s+should\s+i|what\s+time\s+should\s+i|when\s+do\s+i\s+(?:need\s+to|have\s+to)|niende\s+lini)\b/i;
const DEADLINE_SIGNAL = /\b(?:by|before)\s+(?:\d{1,2}(?:[.:]\d{2})?(?:\s*(?:am|pm|hrs))?|noon|midnight)\b/i;
const MEETING_SIGNAL = /\b(?:\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)\s+meeting|meeting\s+(?:at|by)\s+\d{1,2})\b/i;

const tests = [
  'Palace Apartments to Burn Manufacturing before 8',
  'I need to be there by 08:00',
  'niende lini ili nifike by 8',
  'I have a 9am meeting at Westlands',
  'Karen to CBD by 08:00',
  'Karen to CBD by 8',
  'Karen to CBD 9am meeting',
  'matatu from CBD to Kibera before 18:00'
];

for (const t of tests) {
  const isDeadline = DEPART_QUESTION.test(t) || DEADLINE_SIGNAL.test(t) || MEETING_SIGNAL.test(t);
  console.log(`"${t}" =>`, isDeadline);
}

const intactTests = [
  'matatu CBD to Westlands via by-pass',
  'how long by road from Karen to CBD',
  'route passing by Sarit Centre to Karen'
];

for (const t of intactTests) {
  const isDeadline = DEPART_QUESTION.test(t) || DEADLINE_SIGNAL.test(t) || MEETING_SIGNAL.test(t);
  console.log(`"${t}" =>`, isDeadline);
}
