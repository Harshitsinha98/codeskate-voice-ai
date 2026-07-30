/**
 * Codeskate Voice AI — Server Entry Point.
 *
 * Architecture (WebSocket mode — requires always-on server like Fly.io):
 *   1. Plivo sends inbound call webhook → /plivo/inbound
 *   2. We respond with XML telling Plivo to stream audio to our WebSocket
 *   3. WebSocket receives raw audio → Whisper STT → GPT-4.1-nano → OpenAI TTS
 *   4. TTS audio streams back to Plivo → customer hears AI response
 *
 * Features:
 *   - Real-time bidirectional audio (no lag)
 *   - OpenAI TTS (human-like voice, not robotic Polly)
 *   - Filler words ("Ji...", "Hmm..." while AI thinks)
 *   - Barge-in detection (customer can interrupt)
 *   - Silence-based turn detection
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { handleVoiceStream } from "./pipeline/voiceStreamHandler.js";
import { callLogRoutes } from "./routes/callLogs.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "websocket-realtime" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use("/plivo", plivoRoutes);
app.use("/api", callLogRoutes);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/voice-stream" });

wss.on("connection", (ws, req) => {
  logger.info({ url: req.url }, "Voice stream WebSocket connected");
  handleVoiceStream(ws);
});

server.listen(config.port, () => {
  logger.info({
    port: config.port,
    mode: "WebSocket real-time",
    webhookUrl: `${config.publicBaseUrl}/plivo/inbound`,
    wsUrl: `${config.publicBaseUrl.replace("https://", "wss://")}/voice-stream`,
  }, "Codeskate Voice AI started");
});
