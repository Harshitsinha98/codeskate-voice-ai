/**
 * Voice Stream Handler — real-time bidirectional audio with Plivo.
 *
 * Uses the EXACT Plivo Audio Streaming protocol:
 *   IN (from Plivo):
 *     - start:  { event, start: { callId, streamId, mediaFormat: { encoding, sampleRate } } }
 *     - media:  { event, media: { payload (base64) } }
 *     - stop:   { event }
 *   OUT (to Plivo):
 *     - playAudio: { event: "playAudio", media: { contentType, sampleRate, payload } }
 *     - clearAudio: { event: "clearAudio", streamId }   (barge-in / interrupt)
 *
 * Pipeline: collect audio -> silence detect -> STT -> GPT -> TTS -> playAudio.
 */

import { logger } from "../config/logger.js";
import { transcribeAudio } from "./stt.js";
import { generateResponse } from "./llm.js";
import { synthesizeSpeech } from "./tts.js";
import { getAgentConfig } from "../services/agentConfig.js";
import { appendTranscript } from "../services/callLogger.js";

// Lower silence threshold = faster response (was 1500). 700ms feels snappy.
const SILENCE_THRESHOLD_MS = 700;
const MIN_SPEECH_BYTES = 4000; // ignore tiny blips (~0.25s)

export function handleVoiceStream(ws) {
  let audioBuffer = [];
  let silenceTimer = null;
  let isProcessing = false;
  let isSpeaking = false;
  let streamId = null;
  let callUuid = null;
  let mediaFormat = { encoding: "audio/x-mulaw", sampleRate: 8000 };
  const conversation = [];

  const agent = getAgentConfig();
  conversation.push({ role: "system", content: agent.systemPrompt });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case "start": {
        streamId = msg.start?.streamId || msg.streamId;
        callUuid = msg.start?.callId || null;
        if (msg.start?.mediaFormat) mediaFormat = msg.start.mediaFormat;
        logger.info({ streamId, callUuid, mediaFormat }, "Stream started");
        // Greet immediately
        await speak(agent.greeting || "Hello, Codeskate se Priya bol rahi hoon. Boliye, kaise help karoon?");
        break;
      }

      case "media": {
        const payload = msg.media?.payload;
        if (!payload) break;

        // Barge-in: if AI is speaking and caller starts talking, stop AI audio
        if (isSpeaking) {
          const chunk = Buffer.from(payload, "base64");
          if (hasSignificantAudio(chunk)) {
            clearPlayback();
          }
          break;
        }
        if (isProcessing) break;

        audioBuffer.push(payload);
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(processTurn, SILENCE_THRESHOLD_MS);
        break;
      }

      case "stop":
        logger.info({ streamId }, "Stream stopped");
        cleanup();
        break;
    }
  });

  ws.on("close", () => { logger.info({ callUuid }, "WebSocket closed"); cleanup(); });
  ws.on("error", (err) => { logger.error({ err: err.message }, "WebSocket error"); cleanup(); });

  async function processTurn() {
    if (isProcessing || audioBuffer.length === 0) return;
    isProcessing = true;
    const chunks = audioBuffer;
    audioBuffer = [];

    try {
      const raw = Buffer.concat(chunks.map((b) => Buffer.from(b, "base64")));
      if (raw.length < MIN_SPEECH_BYTES) { isProcessing = false; return; }

      const userText = await transcribeAudio(raw, mediaFormat);
      if (!userText || userText.trim().length < 2) { isProcessing = false; return; }

      logger.info({ userText, callUuid }, "User said");
      appendTranscript(callUuid, "user", userText);

      conversation.push({ role: "user", content: userText });
      const reply = await generateResponse(conversation);
      conversation.push({ role: "assistant", content: reply });

      logger.info({ reply: reply.slice(0, 80), callUuid }, "AI reply");
      appendTranscript(callUuid, "assistant", reply);

      await speak(reply);
    } catch (err) {
      logger.error({ err: err.message, callUuid }, "Turn processing error");
    }
    isProcessing = false;
  }

  /** Generate TTS and stream it to Plivo via playAudio. */
  async function speak(text) {
    try {
      const mulaw = await synthesizeSpeech(text); // returns mulaw 8kHz buffer
      if (!mulaw || ws.readyState !== 1) return;

      isSpeaking = true;
      // Send as ONE playAudio event (Plivo buffers and plays it).
      const msg = JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: 8000,
          payload: mulaw.toString("base64"),
        },
      });
      ws.send(msg);

      // Estimate playback duration to release isSpeaking (mulaw 8kHz = 8000 bytes/sec)
      const durationMs = Math.ceil((mulaw.length / 8000) * 1000);
      setTimeout(() => { isSpeaking = false; }, durationMs + 300);

      logger.info({ bytes: mulaw.length, durationMs, callUuid }, "Sent playAudio");
    } catch (err) {
      logger.error({ err: err.message }, "speak() failed");
      isSpeaking = false;
    }
  }

  /** Interrupt current AI audio (barge-in). */
  function clearPlayback() {
    if (ws.readyState === 1 && streamId) {
      ws.send(JSON.stringify({ event: "clearAudio", streamId }));
    }
    isSpeaking = false;
    logger.debug("Barge-in — cleared audio");
  }

  function cleanup() {
    if (silenceTimer) clearTimeout(silenceTimer);
    audioBuffer = [];
    isProcessing = false;
    isSpeaking = false;
  }
}

/** Energy-based voice activity detection on mulaw audio. */
function hasSignificantAudio(chunk) {
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) energy += Math.abs(chunk[i] - 0x7F);
  return chunk.length > 0 && (energy / chunk.length) > 15;
}
