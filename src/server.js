/**
 * Codeskate Voice AI — Server Entry Point.
 *
 * WebSocket mode with OpenAI TTS (natural voice):
 *   Plivo <Stream> sends audio → WebSocket → Whisper STT → GPT → OpenAI TTS → back
 *
 * Also serves /audio/:id for HTTP TTS fallback if needed.
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { handleVoiceStream } from "./pipeline/voiceStreamHandler.js";
import { callLogRoutes } from "./routes/callLogs.js";
import { getAudioById } from "./pipeline/tts.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "websocket-realtime" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Audio serving endpoint (fallback)
app.get("/audio/:id", (req, res) => {
  const audio = getAudioById(req.params.id);
  if (!audio) return res.status(404).send("Not found");
  res.set("Content-Type", audio.contentType);
  res.send(audio.buffer);
});

// Plivo webhook routes
app.use("/plivo", plivoRoutes);

// Call logs API
app.use("/api", callLogRoutes);

// HTTP + WebSocket server on same port
const server = createServer(app);

// WebSocket server — Plivo connects here for audio streaming
const wss = new WebSocketServer({ server, path: "/voice-stream" });

wss.on("connection", (ws, req) => {
  logger.info({ url: req.url, headers: req.headers.upgrade }, "Voice stream WebSocket connected!");
  handleVoiceStream(ws);
});

wss.on("error", (err) => {
  logger.error({ err: err.message }, "WebSocket server error");
});

server.listen(config.port, "0.0.0.0", () => {
  logger.info({
    port: config.port,
    host: "0.0.0.0",
    mode: "WebSocket real-time + HTTP fallback",
    webhookUrl: `${config.publicBaseUrl}/plivo/inbound`,
    wsUrl: `${config.publicBaseUrl.replace("https://", "wss://")}/voice-stream`,
  }, "Codeskate Voice AI started");
});
