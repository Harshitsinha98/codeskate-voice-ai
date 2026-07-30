/**
 * Plivo Webhook Routes — HTTP-only approach (No WebSocket).
 *
 * Flow:
 *   1. /inbound — Call arrives, greet + start recording user speech
 *   2. /handle-speech — Recording done, transcribe + GPT + respond + record again
 *   3. /status — Call ended
 *
 * This approach works on ANY hosting (including Render free tier)
 * because it uses only HTTP POST webhooks, no WebSocket required.
 */

import { Router } from "express";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createCallLog, updateCallLog, appendTranscript } from "../services/callLogger.js";
import { transcribeFromUrl } from "../pipeline/stt.js";
import { generateResponse } from "../pipeline/llm.js";
import { getAgentConfig } from "../services/agentConfig.js";

export const plivoRoutes = Router();

// In-memory conversation state per call (cleared on hangup)
const callStates = new Map();

function getCallState(callUuid) {
  if (!callStates.has(callUuid)) {
    const agentConfig = getAgentConfig();
    callStates.set(callUuid, {
      messages: [{ role: "system", content: agentConfig.systemPrompt }],
      turnCount: 0,
    });
  }
  return callStates.get(callUuid);
}

/**
 * Inbound call — greet the customer and start listening.
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

  // Greet + Record user's speech
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Namaste, main aapki kaise madad kar sakti hoon?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="3" finishOnKey="#" recordSession="false" redirect="true" />
  <Speak voice="Polly.Aditi" language="hi-IN">Maaf kijiye, aapki awaaz nahi aa rahi. Kripya dobara bolein.</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;

  res.set("Content-Type", "application/xml");
  res.send(xml);
});

/**
 * Handle recorded speech — transcribe, get AI response, speak it, record again.
 */
plivoRoutes.post("/handle-speech", async (req, res) => {
  const { CallUUID, RecordUrl, RecordingDuration } = req.body;
  logger.info({ callUuid: CallUUID, recordUrl: RecordUrl, duration: RecordingDuration }, "Speech recorded");

  try {
    const state = getCallState(CallUUID);
    state.turnCount++;

    // Skip if recording too short (likely silence/noise)
    if (!RecordUrl || Number(RecordingDuration) < 1) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Kya aap kuch bolna chahte hain? Main sun rahi hoon.</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    // 1. Transcribe the recording (download from Plivo URL → Whisper)
    const userText = await transcribeFromUrl(RecordUrl);

    if (!userText || userText.trim().length === 0) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Maaf kijiye, main samajh nahi paayi. Kya aap dobara bol sakte hain?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    logger.info({ userText, callUuid: CallUUID, turn: state.turnCount }, "User said");
    appendTranscript(CallUUID, "user", userText);

    // 2. Check for goodbye/end indicators
    const goodbyeWords = ["bye", "thank", "ok bye", "dhanyavaad", "theek hai", "bas", "alvida"];
    const isGoodbye = goodbyeWords.some((w) => userText.toLowerCase().includes(w));

    // 3. Generate AI response
    state.messages.push({ role: "user", content: userText });
    const aiResponse = await generateResponse(state.messages);
    state.messages.push({ role: "assistant", content: aiResponse });

    logger.info({ aiResponse: aiResponse.slice(0, 100), callUuid: CallUUID }, "AI response");
    appendTranscript(CallUUID, "assistant", aiResponse);

    // 4. Speak response + record next turn (or end if goodbye)
    let xml;
    if (isGoodbye || state.turnCount >= 20) {
      // End the call gracefully
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">${escapeXml(aiResponse)} Dhanyavaad, aapka din shubh ho!</Speak>
  <Hangup />
</Response>`;
      // Cleanup state
      callStates.delete(CallUUID);
    } else {
      // Continue conversation
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">${escapeXml(aiResponse)}</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="4" finishOnKey="#" recordSession="false" redirect="true" />
  <Speak voice="Polly.Aditi" language="hi-IN">Aur kuch madad chahiye?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
    }

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    logger.error({ err: err.message, callUuid: CallUUID }, "Handle speech error");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Ek technical samasya aa gayi hai. Kripya thodi der baad dubara try karein.</Speak>
  <Hangup />
</Response>`;
    res.set("Content-Type", "application/xml");
    res.send(xml);
  }
});

/**
 * Call status callback.
 */
plivoRoutes.post("/status", (req, res) => {
  const { CallUUID, CallStatus, Duration, EndTime, HangupCause } = req.body;
  logger.info({ callUuid: CallUUID, status: CallStatus, duration: Duration, hangupCause: HangupCause }, "Call status update");
  updateCallLog(CallUUID, { status: CallStatus, duration: Number(Duration) || 0, endedAt: EndTime || new Date().toISOString(), hangupCause: HangupCause || null });
  // Cleanup conversation state
  callStates.delete(CallUUID);
  res.sendStatus(200);
});

/**
 * Outbound call initiation.
 */
plivoRoutes.post("/outbound", async (req, res) => {
  const { to, agentPrompt } = req.body;
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
        answer_url: `${config.publicBaseUrl}/plivo/inbound`,
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
 * Escape special XML characters in AI response text.
 */
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
