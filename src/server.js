/**
 * Codeskate Voice AI — Server Entry Point.
 *
 * HTTP-only with OpenAI TTS (natural human-like voice):
 *   1. Plivo calls /plivo/inbound → we generate TTS audio → return <Play> + <Record>
 *   2. Customer speaks → Plivo records → POSTs to /plivo/handle-speech
 *   3. We transcribe (Whisper) → generate response (GPT) → TTS audio → <Play> + <Record>
 *   4. Plivo fetches audio from /audio/:id → plays to customer
 *   5. Loop until conversation ends
 *
 * No WebSocket needed. Works on any hosting.
 * Voice quality: OpenAI TTS "alloy" — natural, human-like.
 */

import express from "express";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { callLogRoutes } from "./routes/callLogs.js";
import { getAudioById } from "./pipeline/tts.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "http-openai-tts" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Audio serving endpoint — Plivo <Play> fetches TTS audio from here
app.get("/audio/:id", (req, res) => {
  const audio = getAudioById(req.params.id);
  if (!audio) {
    logger.warn({ id: req.params.id }, "Audio not found");
    return res.status(404).send("Audio not found");
  }
  res.set("Content-Type", audio.contentType);
  res.set("Content-Length", audio.buffer.length);
  res.send(audio.buffer);
});

// Plivo webhook routes
app.use("/plivo", plivoRoutes);

// Call logs API
app.use("/api", callLogRoutes);

app.listen(config.port, "0.0.0.0", () => {
  logger.info({
    port: config.port,
    host: "0.0.0.0",
    mode: "HTTP + OpenAI TTS (natural voice)",
    webhookUrl: `${config.publicBaseUrl}/plivo/inbound`,
  }, "Codeskate Voice AI started");
});
