/**
 * Plivo Webhook Routes — HTTP-only with OpenAI TTS (Natural Voice).
 *
 * NO WebSocket needed. Uses Plivo's <Play> + <Record> + HTTP webhooks.
 * Voice: OpenAI TTS (human-like) served as audio files via /audio/:id endpoint.
 *
 * Flow:
 *   1. /inbound → Generate greeting with OpenAI TTS → <Play> audio + <Record>
 *   2. /handle-speech → Download recording → Whisper → GPT → OpenAI TTS → <Play> + <Record>
 *   3. Loop until conversation ends
 */

import { Router } from "express";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createCallLog, updateCallLog, appendTranscript } from "../services/callLogger.js";
import { transcribeFromUrl } from "../pipeline/stt.js";
import { generateResponse } from "../pipeline/llm.js";
import { synthesizeSpeechToFile } from "../pipeline/tts.js";
import { getAgentConfig } from "../services/agentConfig.js";

export const plivoRoutes = Router();

// In-memory conversation state per call
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
 * Inbound call — greet with OpenAI TTS natural voice + start recording.
 */
plivoRoutes.post("/inbound", async (req, res) => {
  const { CallUUID, From, To, Direction, CallStatus } = req.body;
  logger.info({ callUuid: CallUUID, from: From, to: To }, "Inbound call received");

  createCallLog({
    callUuid: CallUUID, from: From, to: To,
    direction: Direction || "inbound",
    status: CallStatus || "ringing",
    startedAt: new Date().toISOString(),
  });

  try {
    // Generate greeting audio with OpenAI TTS (natural voice)
    const greetingId = await synthesizeSpeechToFile("Namaste! Main Codeskate ki taraf se bol rahi hoon. Aapki kaise madad kar sakti hoon?");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${greetingId}</Play>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${CallUUID}" method="POST" maxLength="30" timeout="3" finishOnKey="#" recordSession="false" redirect="true" />
  <Play>${config.publicBaseUrl}/audio/${greetingId}</Play>
</Response>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
    logger.info({ callUuid: CallUUID, greetingId }, "Sent greeting XML");
  } catch (err) {
    logger.error({ err: err.message, callUuid: CallUUID }, "Inbound handler error");
    // Fallback to Polly if TTS fails
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Namaste, main aapki kaise madad kar sakti hoon?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${CallUUID}" method="POST" maxLength="30" timeout="3" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
    res.set("Content-Type", "application/xml");
    res.send(xml);
  }
});

/**
 * Handle recorded speech — transcribe → GPT → TTS → respond.
 */
plivoRoutes.post("/handle-speech", async (req, res) => {
  const { RecordUrl, RecordingDuration } = req.body;
  const callUuid = req.query.callUuid || req.body.CallUUID;
  logger.info({ callUuid, recordUrl: RecordUrl, duration: RecordingDuration }, "Speech recorded");

  try {
    const state = getCallState(callUuid);
    state.turnCount++;

    // Skip if too short
    if (!RecordUrl || Number(RecordingDuration) < 1) {
      const promptId = await synthesizeSpeechToFile("Kya aap kuch kehna chahte hain? Main sun rahi hoon.");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${promptId}</Play>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    // 1. Transcribe
    const userText = await transcribeFromUrl(RecordUrl);
    if (!userText || userText.trim().length === 0) {
      const retryId = await synthesizeSpeechToFile("Maaf kijiye, mujhe thik se sunai nahi diya. Kya aap dobara bol sakte hain?");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${retryId}</Play>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="5" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    logger.info({ userText, callUuid, turn: state.turnCount }, "User said");
    appendTranscript(callUuid, "user", userText);

    // 2. Check for goodbye
    const goodbyeWords = ["bye", "thank", "ok bye", "dhanyavaad", "theek hai", "bas", "alvida", "chalo"];
    const isGoodbye = goodbyeWords.some((w) => userText.toLowerCase().includes(w));

    // 3. Generate AI response
    state.messages.push({ role: "user", content: userText });
    const aiResponse = await generateResponse(state.messages);
    state.messages.push({ role: "assistant", content: aiResponse });

    logger.info({ aiResponse: aiResponse.slice(0, 100), callUuid }, "AI response");
    appendTranscript(callUuid, "assistant", aiResponse);

    // 4. Generate TTS audio
    const responseId = await synthesizeSpeechToFile(aiResponse);

    // 5. Build XML
    let xml;
    if (isGoodbye || state.turnCount >= 20) {
      const byeText = aiResponse + " Dhanyavaad! Aapka din shubh ho.";
      const byeId = await synthesizeSpeechToFile(byeText);
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${byeId}</Play>
  <Hangup />
</Response>`;
      callStates.delete(callUuid);
    } else {
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${responseId}</Play>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="4" finishOnKey="#" recordSession="false" redirect="true" />
</Response>`;
    }

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    logger.error({ err: err.message, callUuid }, "Handle speech error");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Aditi" language="hi-IN">Ek technical issue aa gayi hai. Kripya thodi der baad try karein.</Speak>
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
  callStates.delete(CallUUID);
  res.sendStatus(200);
});

/**
 * Outbound call.
 */
plivoRoutes.post("/outbound", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to'" });
  if (!config.plivo.authId) return res.status(500).json({ error: "Plivo not configured" });

  try {
    const authHeader = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");
    const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({
        from: config.plivo.phoneNumber, to,
        answer_url: `${config.publicBaseUrl}/plivo/inbound`,
        answer_method: "POST",
        hangup_url: `${config.publicBaseUrl}/plivo/status`,
        hangup_method: "POST",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || JSON.stringify(data));
    res.json({ success: true, callUuid: data.request_uuid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
