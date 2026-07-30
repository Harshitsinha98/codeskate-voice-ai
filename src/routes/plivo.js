/**
 * Plivo Webhook Routes — WebSocket streaming mode.
 *
 * Inbound call → Plivo streams audio bidirectionally via WebSocket →
 * Our server processes in real-time (STT → LLM → TTS) → audio back to caller.
 *
 * Voice: OpenAI TTS (human-like, not Polly)
 * Latency: ~1-1.5 sec (real-time streaming)
 */

import { Router } from "express";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createCallLog, updateCallLog } from "../services/callLogger.js";

export const plivoRoutes = Router();

/**
 * Inbound call — start bidirectional audio stream.
 */
plivoRoutes.post("/inbound", (req, res) => {
  const { CallUUID, From, To, Direction, CallStatus } = req.body;
  logger.info({ callUuid: CallUUID, from: From, to: To }, "Inbound call received");

  createCallLog({
    callUuid: CallUUID,
    from: From,
    to: To,
    direction: Direction || "inbound",
    status: CallStatus || "ringing",
    startedAt: new Date().toISOString(),
  });

  const wsUrl = config.publicBaseUrl.replace("https://", "wss://").replace("http://", "ws://") + "/voice-stream";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" streamTimeout="3600" contentType="audio/x-mulaw;rate=8000" audioTrack="both" statusCallbackUrl="${config.publicBaseUrl}/plivo/stream-status">${wsUrl}?callUuid=${CallUUID}&amp;from=${encodeURIComponent(From)}&amp;to=${encodeURIComponent(To)}</Stream>
</Response>`;

  res.set("Content-Type", "application/xml");
  res.send(xml);
});

/**
 * Stream status callback.
 */
plivoRoutes.post("/stream-status", (req, res) => {
  logger.info({ body: req.body }, "Stream status callback");
  res.sendStatus(200);
});

/**
 * Call status callback.
 */
plivoRoutes.post("/status", (req, res) => {
  const { CallUUID, CallStatus, Duration, EndTime, HangupCause } = req.body;
  logger.info({ callUuid: CallUUID, status: CallStatus, duration: Duration, hangupCause: HangupCause }, "Call status update");
  updateCallLog(CallUUID, { status: CallStatus, duration: Number(Duration) || 0, endedAt: EndTime || new Date().toISOString(), hangupCause: HangupCause || null });
  res.sendStatus(200);
});

/**
 * Outbound call initiation.
 */
plivoRoutes.post("/outbound", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' phone number" });
  if (!config.plivo.authId) return res.status(500).json({ error: "Plivo not configured" });

  try {
    const authHeader = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");

    const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({
        from: config.plivo.phoneNumber,
        to,
        answer_url: `${config.publicBaseUrl}/plivo/outbound-answer`,
        answer_method: "POST",
        hangup_url: `${config.publicBaseUrl}/plivo/status`,
        hangup_method: "POST",
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || JSON.stringify(data));
    logger.info({ to, requestUuid: data.request_uuid }, "Outbound call initiated");
    res.json({ success: true, callUuid: data.request_uuid });
  } catch (err) {
    logger.error({ err: err.message, to }, "Outbound call failed");
    res.status(500).json({ error: err.message });
  }
});

/**
 * Outbound call answer — customer picked up.
 */
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
