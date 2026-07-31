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

        // While AI is speaking, IGNORE incoming audio entirely (no barge-in).
        // Barge-in was clearing our own greeting due to line noise/echo.
        // Simpler + reliable: let AI finish, then listen.
        if (isSpeaking || isProcessing) break;

        audioBuffer.push(payload);
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(processTurn, SILENCE_THRESHOLD_MS);
        break;
      }

      case "stop":
        logger.info({ streamId }, "Stream stopped");
        cleanup();
        break;

      case "playedStream":
        // Plivo confirmed audio finished playing → start listening
        isSpeaking = false;
        logger.info({ name: msg.name, callUuid }, "Plivo confirmed playback done");
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
      const pcm = await synthesizeSpeech(text); // returns L16 PCM 8kHz buffer
      if (!pcm || ws.readyState !== 1) return;

      isSpeaking = true;

      // Chunk audio (Plivo max 64KB per WS message, recommended <=16KB base64)
      const CHUNK = 6400; // 0.4s of L16 8kHz audio per chunk
      let chunksSent = 0;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        if (ws.readyState !== 1) break;
        const slice = pcm.slice(i, i + CHUNK);
        ws.send(JSON.stringify({
          event: "playAudio",
          media: {
            contentType: "audio/x-mulaw",
            sampleRate: 8000,
            payload: slice.toString("base64"),
          },
        }));
        chunksSent++;
      }

      // Send checkpoint — Plivo will send "playedStream" when audio finishes playing.
      // Use this to know when to start listening again.
      if (ws.readyState === 1 && streamId) {
        ws.send(JSON.stringify({ event: "checkpoint", streamId, name: `speak_${Date.now()}` }));
      }

      // mulaw 8kHz = 8000 bytes/sec (1 byte per sample). Estimate + safety.
      const durationMs = Math.ceil((pcm.length / 8000) * 1000);
      // Release isSpeaking after estimated playback (Plivo may confirm earlier via playedStream)
      setTimeout(() => { isSpeaking = false; }, durationMs + 500);

      logger.info({ bytes: pcm.length, chunksSent, durationMs, callUuid }, "Sent playAudio (L16, chunked)");
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
