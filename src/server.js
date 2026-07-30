/**
 * Codeskate Voice AI — WebSocket real-time mode.
 *
 * Plivo <Stream> streams call audio bidirectionally over WebSocket.
 * Pipeline: audio in -> STT -> GPT -> TTS -> audio out (real-time, low latency).
 *
 * Uses the exact Plivo Audio Streaming protocol:
 *   IN:  start (streamId, callId, mediaFormat), media (payload), stop
 *   OUT: playAudio (contentType, sampleRate, payload), clearAudio
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { callLogRoutes } from "./routes/callLogs.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "websocket" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use("/plivo", plivoRoutes);
app.use("/api", callLogRoutes);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/voice-stream" });

wss.on("connection", async (ws, req) => {
  logger.info({ url: req.url }, "Voice stream WebSocket connected!");
  // Lazy import to keep startup fast
  const { handleVoiceStream } = await import("./pipeline/voiceStreamHandler.js");
  handleVoiceStream(ws);
});

wss.on("error", (err) => logger.error({ err: err.message }, "WebSocket server error"));

server.listen(config.port, "0.0.0.0", () => {
  logger.info({
    port: config.port,
    mode: "WebSocket real-time",
    wsUrl: `${config.publicBaseUrl.replace("https://", "wss://")}/voice-stream`,
  }, "Codeskate Voice AI started");
});
