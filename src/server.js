/**
 * Codeskate Voice AI — Server Entry Point.
 *
 * HTTP-only architecture (no WebSocket needed):
 *   1. Plivo calls /plivo/inbound → we return XML with <Speak> + <Record>
 *   2. Customer speaks → Plivo records → sends recording URL to /plivo/handle-speech
 *   3. We download recording → Whisper transcribe → GPT response → return <Speak> + <Record>
 *   4. Loop continues until call ends
 *
 * Works on ANY free hosting (Render, Railway, etc.) — no WebSocket required.
 */

import express from "express";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { callLogRoutes } from "./routes/callLogs.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "http-only" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Plivo webhook routes
app.use("/plivo", plivoRoutes);

// Call logs API
app.use("/api", callLogRoutes);

app.listen(config.port, () => {
  logger.info({
    port: config.port,
    mode: "HTTP-only (no WebSocket)",
    webhookUrl: `${config.publicBaseUrl}/plivo/inbound`,
  }, "Codeskate Voice AI started");
});
