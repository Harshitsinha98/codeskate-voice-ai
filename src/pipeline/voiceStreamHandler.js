/**
 * Voice Stream Handler — bridges Plivo audio stream to AI pipeline.
 */

import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { transcribeAudio } from "./stt.js";
import { generateResponse } from "./llm.js";
import { synthesizeSpeech } from "./tts.js";
import { getAgentConfig } from "../services/agentConfig.js";
import { appendTranscript } from "../services/callLogger.js";

const SILENCE_THRESHOLD_MS = 1500;

export function handleVoiceStream(ws) {
  let audioBuffer = [];
  let silenceTimer = null;
  let isProcessing = false;
  let isSpeaking = false;
  let conversationHistory = [];
  let callUuid = null;
  let streamSid = null;

  const agentConfig = getAgentConfig();
  conversationHistory.push({ role: "system", content: agentConfig.systemPrompt });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "start":
          streamSid = msg.start?.streamSid || msg.streamSid;
          callUuid = msg.start?.callId || msg.start?.customParameters?.callUuid;
          logger.info({ streamSid, callUuid }, "Audio stream started");
          // Send greeting via TTS as soon as stream connects
          sendGreeting(ws, streamSid);
          break;

        case "media":
          if (isProcessing || isSpeaking) {
            if (isSpeaking && msg.media?.payload) {
              const chunk = Buffer.from(msg.media.payload, "base64");
              if (hasSignificantAudio(chunk)) {
                isSpeaking = false;
                logger.debug("Barge-in detected");
              }
            }
            break;
          }
          if (msg.media?.payload) audioBuffer.push(msg.media.payload);
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => processUserSpeech(), SILENCE_THRESHOLD_MS);
          break;

        case "stop":
          logger.info({ streamSid }, "Audio stream stopped");
          cleanup();
          break;
      }
    } catch (err) {
      logger.error({ err: err.message }, "Stream message error");
    }
  });

  ws.on("close", () => { logger.info({ callUuid }, "WebSocket closed"); cleanup(); });
  ws.on("error", (err) => { logger.error({ err: err.message }, "WebSocket error"); cleanup(); });

  async function processUserSpeech() {
    if (audioBuffer.length === 0 || isProcessing) return;
    isProcessing = true;
    const chunks = [...audioBuffer];
    audioBuffer = [];

    try {
      const rawAudio = Buffer.concat(chunks.map((b64) => Buffer.from(b64, "base64")));
      if (rawAudio.length < 1600) { isProcessing = false; return; }

      const userText = await transcribeAudio(rawAudio);
      if (!userText) { isProcessing = false; return; }

      logger.info({ userText, callUuid }, "User said");
      appendTranscript(callUuid, "user", userText);

      if (config.agent.fillerEnabled) await sendFiller(ws, streamSid);

      conversationHistory.push({ role: "user", content: userText });
      const aiResponse = await generateResponse(conversationHistory);
      conversationHistory.push({ role: "assistant", content: aiResponse });

      logger.info({ aiResponse: aiResponse.slice(0, 100), callUuid }, "AI response");
      appendTranscript(callUuid, "assistant", aiResponse);

      isSpeaking = true;
      await streamTTSToPlivo(ws, streamSid, aiResponse);
      isSpeaking = false;
    } catch (err) {
      logger.error({ err: err.message, callUuid }, "Pipeline error");
      isSpeaking = false;
    }
    isProcessing = false;
  }

  function cleanup() {
    if (silenceTimer) clearTimeout(silenceTimer);
    audioBuffer = [];
    isProcessing = false;
    isSpeaking = false;
  }
}

async function sendFiller(ws, streamSid) {
  try {
    const fillers = ["Ji, ek moment.", "Hmm.", "Bilkul."];
    const filler = fillers[Math.floor(Math.random() * fillers.length)];
    const audio = await synthesizeSpeech(filler);
    if (audio && ws.readyState === 1) sendAudioToPlivo(ws, streamSid, audio);
  } catch (err) { /* non-fatal */ }
}

async function sendGreeting(ws, streamSid) {
  try {
    const greeting = "Namaste, main aapki kaise madad kar sakti hoon?";
    const audio = await synthesizeSpeech(greeting);
    if (audio && ws.readyState === 1) sendAudioToPlivo(ws, streamSid, audio);
  } catch (err) {
    logger.warn({ err: err.message }, "Greeting TTS failed");
  }
}

async function streamTTSToPlivo(ws, streamSid, text) {
  const audio = await synthesizeSpeech(text);
  if (audio && ws.readyState === 1) sendAudioToPlivo(ws, streamSid, audio);
}

function sendAudioToPlivo(ws, streamSid, audio) {
  const chunkSize = 160;
  for (let i = 0; i < audio.length; i += chunkSize) {
    const chunk = audio.slice(i, i + chunkSize);
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }));
  }
}

function hasSignificantAudio(chunk) {
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) energy += Math.abs(chunk[i] - 0x7F);
  return (energy / chunk.length) > 10;
}
