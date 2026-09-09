import 'dotenv/config';
import { parseIntent } from './src/utils/nlp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const threads = [
  {
    name: "Thread A — 'Deadline, then revision'",
    savedPlaces: {},
    turns: [
      'what time should I leave Palace Apartments to get to Burn Manufacturing by 8.10am',
      'actually I need to be there by 7:45am',
      'is that even possible given traffic?'
    ]
  },
  {
    name: "Thread B — 'Check turns into depart'",
    savedPlaces: {},
    turns: [
      'how long is it from Kahawa Sukari to Westlands?',
      'I need to be there by 9am, when should I leave?',
      'set a watch for me'
    ]
  },
  {
    name: "Thread C — 'Saved places + deadline'",
    savedPlaces: { home: 'Palace Apartments Limuru Road', work: 'Burn Manufacturing Westlands' },
    turns: [
      'what time should I leave for work to be there by 8am?',
      'what about tomorrow if I leave by 8:30am, will I make it?'
    ]
  },
  {
    name: "Thread D — 'Sheng/Swahili deadline'",
    savedPlaces: {},
    turns: [
      'nataka kufika town by 8am, niko Karen',
      'sawa, ni saa ngapi niende?'
    ]
  }
];

async function runTests() {
  for (const thread of threads) {
    console.log(`\n======================================================`);
    console.log(`Testing ${thread.name}`);
    console.log(`======================================================\n`);
    
    let conversationHistory = [];
    
    for (let i = 0; i < thread.turns.length; i++) {
      const userMessage = thread.turns[i];
      console.log(`\n--- Turn ${i + 1} ---`);
      console.log(`User: "${userMessage}"`);
      console.log(`Saved Places:`, thread.savedPlaces);
      console.log(`Conversation History Passed:`, JSON.stringify(conversationHistory, null, 2));
      
      try {
        const intent = await parseIntent(userMessage, thread.savedPlaces, conversationHistory);
        console.log(`\nGemini Intent returned:`, JSON.stringify(intent, null, 2));
        console.log(`Command Extracted: ${intent.command}`);
        console.log(`Arrive By Extracted: ${intent.arrive_by}`);
        
        conversationHistory.push({
          userMessage,
          modelResponse: JSON.stringify(intent)
        });
        
      } catch (e) {
        console.error(`Error on Turn ${i + 1}:`, e.message);
      }
      
      console.log(`\nWaiting 5 seconds before next call...`);
      await sleep(5000);
    }
  }
}

runTests();
