/**
 * Codeskate Voice AI — HTTP mode (PROVEN WORKING).
 *
 * This mode works reliably on Plivo India trial.
 * Greeting: Polly (instant). Responses: OpenAI TTS (natural).
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

app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Audio endpoint — Plivo <Play> fetches TTS audio from here
app.get("/audio/:id", (req, res) => {
  const audio = getAudioById(req.params.id);
  if (!audio) return res.status(404).send("Not found");
  res.set("Content-Type", audio.contentType);
  res.send(audio.buffer);
});

app.use("/plivo", plivoRoutes);
app.use("/api", callLogRoutes);

app.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port, host: "0.0.0.0", webhookUrl: `${config.publicBaseUrl}/plivo/inbound` }, "Codeskate Voice AI started");
});
