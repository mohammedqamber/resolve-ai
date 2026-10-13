// Chat with the real agent in your terminal (needs GEMINI_API_KEY in .env):
//   npm run try:agent            -> chat as Alice
//   npm run try:agent -- ben     -> chat as Ben (alice | ben | chloe)
// One conversation is kept for the whole session and saved to a throwaway data file,
// so you can try: "I returned my headphones but have not received my refund." then "Yes, please."
// Type "exit" to quit. (The real login/session comes with the HTTP API in Stage 4.)

import { rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

process.env.DATA_FILE = "data/try-agent.runtime.json";
await rm(process.env.DATA_FILE, { force: true }); // fresh demo data every run

const { initStore } = await import("./data/store.js");
const { chat } = await import("./agent/agent.js");
const { ModelError } = await import("./models/types.js");

await initStore();

const name = (process.argv[2] ?? "alice").toLowerCase();
const customerId = `cus_${name}`;
console.log(`Chatting as ${customerId}. Type "exit" to quit.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let conversationId: string | undefined;

while (true) {
  const message = (await rl.question("You: ")).trim();
  if (!message) continue;
  if (message === "exit") break;

  try {
    const result = await chat({ customerId, message, ...(conversationId ? { conversationId } : {}) });
    conversationId = result.conversationId;
    for (const a of result.activities) console.log(`  [${a.status}] ${a.tool}(${a.inputSummary}) -> ${a.outputSummary}`);
    console.log(`\nAgent: ${result.reply}`);
    if (result.pendingAction) console.log(`  (waiting for your confirmation: ${result.pendingAction.summary})`);
    console.log();
  } catch (err) {
    if (err instanceof ModelError) console.error(`\nModel error (${err.kind}): ${err.message}\n`);
    else throw err;
  }
}
rl.close();
