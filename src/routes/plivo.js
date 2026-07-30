/**
 * Plivo Routes — HTTP mode with OpenAI TTS for AI responses.
 * Greeting: Polly Kajal (instant, no delay).
 * AI Responses: OpenAI TTS via <Play> (natural voice).
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

plivoRoutes.post("/inbound", (req, res) => {
  const { CallUUID, From, To, Direction, CallStatus } = req.body;
  logger.info({ callUuid: CallUUID, from: From, to: To }, "Inbound call received");
  createCallLog({ callUuid: CallUUID, from: From, to: To, direction: Direction || "inbound", status: CallStatus || "ringing", startedAt: new Date().toISOString() });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Kajal" language="hi-IN">Namaste! Codeskate mein aapka swaagat hai. Boliye, main aapki kaise madad karoon?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${CallUUID}" method="POST" maxLength="30" timeout="2" finishOnKey="#" playBeep="false" recordSession="false" redirect="true" />
  <Speak voice="Polly.Kajal" language="hi-IN">Kya aap kuch kehna chahte hain?</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${CallUUID}" method="POST" maxLength="30" timeout="3" finishOnKey="#" playBeep="false" recordSession="false" redirect="true" />
</Response>`;
  res.set("Content-Type", "application/xml");
  res.send(xml);
});

plivoRoutes.post("/handle-speech", async (req, res) => {
  const { RecordUrl, RecordingDuration } = req.body;
  const callUuid = req.query.callUuid || req.body.CallUUID;
  logger.info({ callUuid, recordUrl: RecordUrl, duration: RecordingDuration }, "Speech recorded");

  try {
    const state = getCallState(callUuid);
    state.turnCount++;

    if (!RecordUrl || Number(RecordingDuration) < 1) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Kajal" language="hi-IN">Main sun rahi hoon, boliye.</Speak>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="3" finishOnKey="#" playBeep="false" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    const rawText = await transcribeFromUrl(RecordUrl);
    const userText = cleanTranscript(rawText);

    // If empty OR a known Whisper hallucination (from silence/noise), ask again
    if (!userText || userText.trim().length === 0 || isHallucination(rawText)) {
      logger.info({ rawText, callUuid }, "Empty/hallucination — re-listening");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="4" finishOnKey="#" playBeep="false" recordSession="false" redirect="true" />
</Response>`;
      res.set("Content-Type", "application/xml");
      return res.send(xml);
    }

    logger.info({ userText, callUuid, turn: state.turnCount }, "User said");
    appendTranscript(callUuid, "user", userText);

    const goodbyeWords = ["bye bye", "ok bye", "goodbye", "alvida", "call kaat", "disconnect"];
    const isGoodbye = goodbyeWords.some((w) => userText.toLowerCase().includes(w)) && state.turnCount >= 3;

    state.messages.push({ role: "user", content: userText });
    const aiResponse = await generateResponse(state.messages);
    state.messages.push({ role: "assistant", content: aiResponse });

    logger.info({ aiResponse: aiResponse.slice(0, 100), callUuid }, "AI response");
    appendTranscript(callUuid, "assistant", aiResponse);

    // Generate OpenAI TTS audio (natural voice for AI response)
    const audioId = await synthesizeSpeechToFile(aiResponse);

    let xml;
    if (isGoodbye || state.turnCount >= 20) {
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${audioId}</Play>
  <Speak voice="Polly.Kajal" language="hi-IN">Dhanyavaad! Aapka din shubh ho.</Speak>
  <Hangup />
</Response>`;
      callStates.delete(callUuid);
    } else {
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${config.publicBaseUrl}/audio/${audioId}</Play>
  <Record action="${config.publicBaseUrl}/plivo/handle-speech?callUuid=${callUuid}" method="POST" maxLength="30" timeout="2" finishOnKey="#" playBeep="false" recordSession="false" redirect="true" />
</Response>`;
    }

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (err) {
    logger.error({ err: err.message, callUuid }, "Handle speech error");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="Polly.Kajal" language="hi-IN">Technical issue aa gayi hai. Thodi der baad try karein.</Speak>
  <Hangup />
</Response>`;
    res.set("Content-Type", "application/xml");
    res.send(xml);
  }
});

plivoRoutes.post("/status", (req, res) => {
  const { CallUUID, CallStatus, Duration, EndTime, HangupCause } = req.body;
  logger.info({ callUuid: CallUUID, status: CallStatus, duration: Duration, hangupCause: HangupCause }, "Call status update");
  updateCallLog(CallUUID, { status: CallStatus, duration: Number(Duration) || 0, endedAt: EndTime || new Date().toISOString(), hangupCause: HangupCause || null });
  callStates.delete(CallUUID);
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



/**
 * Whisper hallucinates these phrases on silence/noise. Reject them.
 */
function isHallucination(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();

  // Common Whisper hallucinations on silent/noisy audio
  const hallucinations = [
    "thank you", "thank you.", "thanks for watching", "bye", "hello",
    "shabbat shalom", ".", "you", "so", "okay", "ok",
  ];
  if (hallucinations.includes(t)) return true;

  // Repeated single word: "hello hello hello", "thank you thank you"
  const words = t.replace(/[.,!?]/g, "").split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const unique = new Set(words);
    if (unique.size <= 2) return true; // Mostly repeated words = hallucination
  }

  // Too short to be meaningful (single char or two)
  if (t.replace(/[.,!?\s]/g, "").length < 2) return true;

  return false;
}

/**
 * Clean up transcript — remove excessive repetition and trim.
 */
function cleanTranscript(text) {
  if (!text) return "";
  let t = text.trim();

  // Collapse repeated words ("hello hello hello" -> "hello")
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");

  return t.trim();
}
