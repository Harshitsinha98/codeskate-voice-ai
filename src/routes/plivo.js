/**
 * Plivo Webhook Routes.
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

  // Use wss:// for the WebSocket URL
  const wsUrl = config.publicBaseUrl.replace("https://", "wss://").replace("http://", "ws://") + "/voice-stream";

  // No <Speak> before <Stream> — greeting will come from AI via TTS through the stream.
  // Plivo docs: when keepCallAlive=true, subsequent XML elements are not executed.
  // streamTimeout=3600 keeps the call alive for up to 1 hour.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" streamTimeout="3600" contentType="audio/x-mulaw;rate=8000" audioTrack="both" statusCallbackUrl="${config.publicBaseUrl}/plivo/stream-status">${wsUrl}?callUuid=${CallUUID}&amp;from=${encodeURIComponent(From)}&amp;to=${encodeURIComponent(To)}</Stream>
</Response>`;
  res.set("Content-Type", "application/xml");
  res.send(xml);
});

// Stream status callback — helps debug stream connection issues
plivoRoutes.post("/stream-status", (req, res) => {
  logger.info({ body: req.body }, "Stream status callback");
  res.sendStatus(200);
});

plivoRoutes.post("/status", (req, res) => {
  const { CallUUID, CallStatus, Duration, EndTime, HangupCause } = req.body;
  logger.info({ callUuid: CallUUID, status: CallStatus, duration: Duration }, "Call status update");
  updateCallLog(CallUUID, { status: CallStatus, duration: Number(Duration) || 0, endedAt: EndTime || new Date().toISOString(), hangupCause: HangupCause || null });
  res.sendStatus(200);
});

plivoRoutes.post("/outbound", async (req, res) => {
  const { to, agentPrompt } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' phone number" });
  if (!config.plivo.authId) return res.status(500).json({ error: "Plivo not configured" });

  try {
    const authHeader = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");
    const answerUrl = `${config.publicBaseUrl}/plivo/outbound-answer?prompt=${encodeURIComponent(agentPrompt || "")}`;

    const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({ from: config.plivo.phoneNumber, to, answer_url: answerUrl, answer_method: "POST", hangup_url: `${config.publicBaseUrl}/plivo/status`, hangup_method: "POST" }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Plivo call failed");
    res.json({ success: true, callUuid: data.request_uuid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

plivoRoutes.post("/outbound-answer", (req, res) => {
  const { CallUUID, From, To } = req.body;
  const wsUrl = config.publicBaseUrl.replace("https://", "wss://").replace("http://", "ws://") + "/voice-stream";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" streamTimeout="3600" contentType="audio/x-mulaw;rate=8000" audioTrack="both">${wsUrl}?callUuid=${CallUUID}&amp;from=${encodeURIComponent(From)}&amp;to=${encodeURIComponent(To)}&amp;direction=outbound</Stream>
</Response>`;
  res.set("Content-Type", "application/xml");
  res.send(xml);
});
