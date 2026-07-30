/**
 * Plivo Routes — WebSocket streaming mode.
 *
 * Inbound call -> return <Stream> XML -> Plivo opens bidirectional WebSocket
 * to /voice-stream where the real-time pipeline runs.
 */

import { Router } from "express";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createCallLog, updateCallLog } from "../services/callLogger.js";

export const plivoRoutes = Router();

plivoRoutes.post("/inbound", (req, res) => {
  const { CallUUID, From, To, Direction, CallStatus } = req.body;
  logger.info({ callUuid: CallUUID, from: From, to: To }, "Inbound call received");
  createCallLog({ callUuid: CallUUID, from: From, to: To, direction: Direction || "inbound", status: CallStatus || "ringing", startedAt: new Date().toISOString() });

  const wsUrl = config.publicBaseUrl.replace("https://", "wss://").replace("http://", "ws://") + "/voice-stream";

  // Minimal Stream XML — this exact format connected successfully before.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true">${wsUrl}</Stream>
</Response>`;

  res.set("Content-Type", "application/xml");
  res.send(xml);
  logger.info({ callUuid: CallUUID, wsUrl }, "Sent Stream XML");
});

plivoRoutes.post("/status", (req, res) => {
  const { CallUUID, CallStatus, Duration, EndTime, HangupCause } = req.body;
  logger.info({ callUuid: CallUUID, status: CallStatus, duration: Duration, hangupCause: HangupCause }, "Call status update");
  updateCallLog(CallUUID, { status: CallStatus, duration: Number(Duration) || 0, endedAt: EndTime || new Date().toISOString(), hangupCause: HangupCause || null });
  res.sendStatus(200);
});

plivoRoutes.post("/outbound", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to'" });
  if (!config.plivo.authId) return res.status(500).json({ error: "Plivo not configured" });
  try {
    const authHeader = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");
    const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({ from: config.plivo.phoneNumber, to, answer_url: `${config.publicBaseUrl}/plivo/inbound`, answer_method: "POST", hangup_url: `${config.publicBaseUrl}/plivo/status`, hangup_method: "POST" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || JSON.stringify(data));
    res.json({ success: true, callUuid: data.request_uuid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
