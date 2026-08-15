/**
 * Voice gateway entry point.
 *
 * Runs as its own long-lived Node process, separate from Next.js, because a
 * voice call needs a WebSocket that stays open for minutes — not something a
 * serverless function or a Next route handler can guarantee.
 *
 *   npm run dev:gateway    # ws://localhost:4000/voice
 */

import { startVoiceGateway } from "./voice/websocket-server";

const PORT = Number.parseInt(process.env.VOICE_GATEWAY_PORT ?? "4000", 10);
const PATH = process.env.VOICE_GATEWAY_PATH ?? "/voice";

function log(message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[voice-gateway] ${message}${suffix}`);
}

if (!process.env.GEMINI_API_KEY) {
  console.error(
    "[voice-gateway] GEMINI_API_KEY is missing.\n" +
      "  Copy .env.example to .env.local and add your key, then restart.",
  );
  process.exit(1);
}

const server = startVoiceGateway({ port: PORT, path: PATH, log });

server.on("listening", () => log(`listening on ws://localhost:${PORT}${PATH}`));
server.on("error", (error) => {
  console.error("[voice-gateway] failed to start:", error.message);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, closing ${server.clients.size} call(s)`);

  for (const client of server.clients) client.close(1001, "server shutting down");
  server.close(() => process.exit(0));

  // Never hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[voice-gateway] unhandled rejection:", reason);
});
