/**
 * Codeskate Voice AI — Server Entry Point.
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

app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running" }));
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
  logger.info({ port: config.port, webhookUrl: `${config.publicBaseUrl}/plivo/inbound` }, "Codeskate Voice AI started");
});
