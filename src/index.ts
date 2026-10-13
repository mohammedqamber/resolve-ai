import { createApp } from "./app.js";
import { initStore } from "./data/store.js";
import { config } from "./utils/config.js";

async function main() {
  await initStore();

  if (!config.geminiApiKey) {
    console.warn("GEMINI_API_KEY is not set: /api/chat will answer 503 until you add it to .env.");
  }

  const server = createApp().listen(config.port, () => {
    console.log(`ResolveAI Lite listening on http://localhost:${config.port}`);
  });
  // Node closes idle keep-alive connections after 5s by default, but Render's proxy reuses them for longer.
  // When the proxy sends a request on a socket Node just closed, the user gets a random 502.
  // Keep sockets open longer than the proxy does (headersTimeout must be larger than keepAliveTimeout).
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
