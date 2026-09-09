import 'dotenv/config';
import { quickClassify, parseIntent } from './src/utils/nlp.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const tests = [
  // 1. Deadline phrasing
  'nataka kufika Burn Manufacturing by 8am, niende lini from Palace Apartments?',
  'niache lini ili nifike work by 8.10 if niko Palace Apartments',
  'heading to JKIA need to be there by 6pm from Karen',
  'gotta be at Westlands office before 9, leaving Kahawa Sukari',
  'bado niko home, lazima nifike town by 7:30am',
  
  // 2. Simple check queries
  'Karen to CBD',
  'how long kileleshwa to westlands',
  'Sarit Centre to Junction Mall',
  
  // 3. Ambiguous/tricky cases
  'leaving early for meeting, route to CBD',
  'I need to get there in the next 45 minutes from Yaya Centre',
  'ping me when to leave for the airport if my flight is at 10pm and I am at Karen',
  'traffic to town by the way'
];

async function runTests() {
  for (const text of tests) {
    console.log(`\n--- Test Case: "${text}" ---`);
    
    const quickResult = quickClassify(text);
    console.log('quickClassify:', quickResult);
    
    try {
      const intent = await parseIntent(text);
      console.log('parseIntent:', JSON.stringify(intent, null, 2));
    } catch (err) {
      console.error('ERROR:', err.message);
    }
    
    await delay(5000);
  }
}

runTests();
