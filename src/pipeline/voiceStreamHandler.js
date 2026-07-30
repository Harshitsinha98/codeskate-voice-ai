/**
 * Voice Stream Handler — bridges Plivo audio stream to AI pipeline.
 * With detailed logging to debug audio playback issues.
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
          // Log the FULL start message to understand Plivo's format
          streamSid = msg.start?.streamSid || msg.streamSid || msg.start?.stream_id;
          callUuid = msg.start?.callId || msg.start?.customParameters?.callUuid || msg.start?.from;
          logger.info({ streamSid, callUuid, startMsg: JSON.stringify(msg).slice(0, 500) }, "Audio stream started — FULL start event");
          // Send greeting
          await sendGreeting(ws, streamSid);
          break;

        case "media":
          if (isProcessing || isSpeaking) break;
          if (msg.media?.payload) audioBuffer.push(msg.media.payload);
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => processUserSpeech(), SILENCE_THRESHOLD_MS);
          break;

        case "stop":
          logger.info({ streamSid }, "Audio stream stopped");
          cleanup();
          break;

        default:
          // Log any unknown events to understand Plivo's protocol
          logger.info({ event: msg.event, keys: Object.keys(msg) }, "Unknown stream event");
          break;
      }
    } catch (err) {
      logger.error({ err: err.message, raw: data.toString().slice(0, 200) }, "Stream message error");
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
      logger.info({ audioSize: rawAudio.length, callUuid }, "Processing user speech");

      if (rawAudio.length < 1600) {
        logger.debug({ size: rawAudio.length }, "Audio too short, skipping");
        isProcessing = false;
        return;
      }

      const userText = await transcribeAudio(rawAudio);
      if (!userText) {
        logger.debug("Whisper returned empty, skipping");
        isProcessing = false;
        return;
      }

      logger.info({ userText, callUuid }, "User said");
      appendTranscript(callUuid, "user", userText);

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

async function sendGreeting(ws, streamSid) {
  try {
    logger.info({ streamSid, wsReady: ws.readyState }, "Generating greeting TTS...");
    const greeting = "Namaste! Main Codeskate ki taraf se bol rahi hoon. Aapki kaise madad kar sakti hoon?";
    const audio = await synthesizeSpeech(greeting);

    if (!audio) {
      logger.error("Greeting TTS returned null!");
      return;
    }

    logger.info({ audioSize: audio.length, streamSid, wsReady: ws.readyState }, "Greeting audio generated, sending to Plivo...");

    if (ws.readyState === 1) {
      sendAudioToPlivo(ws, streamSid, audio);
      logger.info({ chunksSent: Math.ceil(audio.length / 160) }, "Greeting audio sent to Plivo");
    } else {
      logger.error({ wsReady: ws.readyState }, "WebSocket not open, cannot send greeting");
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack?.slice(0, 200) }, "Greeting failed");
  }
}

async function streamTTSToPlivo(ws, streamSid, text) {
  try {
    const audio = await synthesizeSpeech(text);
    if (!audio) {
      logger.error("TTS returned null for response");
      return;
    }
    if (ws.readyState === 1) {
      sendAudioToPlivo(ws, streamSid, audio);
      logger.info({ audioSize: audio.length, chunksSent: Math.ceil(audio.length / 160) }, "Response audio sent");
    }
  } catch (err) {
    logger.error({ err: err.message }, "streamTTSToPlivo failed");
  }
}

function sendAudioToPlivo(ws, streamSid, audio) {
  const chunkSize = 160; // 20ms at 8kHz mulaw
  let sent = 0;
  for (let i = 0; i < audio.length; i += chunkSize) {
    const chunk = audio.slice(i, i + chunkSize);
    const msg = JSON.stringify({
      event: "playAudio",
      media: {
        contentType: "audio/x-mulaw;rate=8000",
        sampleRate: 8000,
        payload: chunk.toString("base64"),
      },
    });
    ws.send(msg);
    sent++;
  }
  logger.debug({ sent, streamSid }, "Audio chunks sent to Plivo");
}

function hasSignificantAudio(chunk) {
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) energy += Math.abs(chunk[i] - 0x7F);
  return (energy / chunk.length) > 10;
}
