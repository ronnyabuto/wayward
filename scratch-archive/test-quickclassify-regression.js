import 'dotenv/config';
import { quickClassify } from './src/utils/nlp.js';

const falsePositivesToTest = [
  'matatu CBD to Westlands via by-pass',
  'how long by road from Karen to CBD',
  'route passing by Sarit Centre to Karen'
];

const falseNegativesToTest = [
  'Palace Apartments to Burn Manufacturing before 8',
  'I need to be there by 08:00',
  'niende lini ili nifike by 8',
  'I have a 9am meeting at Westlands'
];

const intactToTest = [
  'traffic from Westlands to CBD',
  'how long from Karen to CBD',
  'matatu from CBD to Kibera',
  'route 23 matatu'
];

console.log("=== CHECK/MATATU ROUTING INTACT ===");
for (const q of intactToTest) {
  const result = quickClassify(q);
  console.log(`"${q}" =>`, result);
}

console.log("\n=== FALSE POSITIVES (Legitimate uses of by/before that are NOT deadlines) ===");
for (const q of falsePositivesToTest) {
  const result = quickClassify(q);
  console.log(`"${q}" =>`, result);
}

console.log("\n=== FALSE NEGATIVES (Deadlines missed by current regex) ===");
for (const q of falseNegativesToTest) {
  const result = quickClassify(q);
  console.log(`"${q}" =>`, result);
}
