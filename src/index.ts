import { createApp } from "./app.js";
import { initStore } from "./data/store.js";
import { config } from "./utils/config.js";

async function main() {
  await initStore();

  if (!config.geminiApiKey) {
    console.warn("GEMINI_API_KEY is not set: /api/chat will answer 503 until you add it to .env.");
  }

  createApp().listen(config.port, () => {
    console.log(`ResolveAI Lite listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
