/**
 * Codeskate Voice AI — using official Plivo Stream SDK.
 *
 * The SDK handles WebSocket protocol, audio encoding/decoding, chunking,
 * and event management. We just focus on AI logic.
 */

import express from "express";
import PlivoWebSocketServer from "plivo-stream-sdk-node";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { plivoRoutes } from "./routes/plivo.js";
import { callLogRoutes } from "./routes/callLogs.js";
import { transcribeAudio } from "./pipeline/stt.js";
import { generateResponse } from "./pipeline/llm.js";
import { synthesizeSpeech } from "./pipeline/tts.js";
import { getAgentConfig } from "./services/agentConfig.js";
import { createCallLog, appendTranscript } from "./services/callLogger.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.json({ service: "codeskate-voice-ai", status: "running", mode: "plivo-sdk" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use("/plivo", plivoRoutes);
app.use("/api", callLogRoutes);

// Start HTTP server
const server = app.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port, mode: "Plivo Stream SDK" }, "Codeskate Voice AI started");
});

// ─── Plivo Stream SDK WebSocket Server ───────────────────────────────────
const plivoServer = new PlivoWebSocketServer({ server, path: "/voice-stream" });

// Per-connection state
const connectionState = new WeakMap();

plivoServer
  .onConnection(async (ws, req) => {
    logger.info("Voice stream connected (SDK)");
    const agent = getAgentConfig();
    connectionState.set(ws, {
      audioBuffer: [],
      silenceTimer: null,
      isProcessing: false,
      isSpeaking: false,
      conversation: [{ role: "system", content: agent.systemPrompt }],
      callUuid: null,
    });
  })
  .onStart(async (event, ws) => {
    const state = connectionState.get(ws);
    state.callUuid = event.start.callId;
    logger.info({ streamId: event.start.streamId, callId: event.start.callId, format: event.start.mediaFormat }, "Stream started (SDK)");

    // Send greeting immediately using SDK's playAudio
    try {
      const agent = getAgentConfig();
      const greeting = agent.greeting || "Hello! Codeskate se Priya bol rahi hoon. Kaise help karoon?";
      const audio = await synthesizeSpeech(greeting);
      if (audio) {
        sendAudio(ws, state, audio, "greeting");
      }
    } catch (err) {
      logger.error({ err: err.message }, "Greeting failed");
    }
  })
  .onMedia((event, ws) => {
    const state = connectionState.get(ws);
    if (!state || state.isSpeaking || state.isProcessing) return;

    // Get raw audio buffer from SDK (handles decoding)
    const audioChunk = event.getRawMedia();
    state.audioBuffer.push(audioChunk);

    // Silence detection — process when user stops talking
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    state.silenceTimer = setTimeout(() => processTurn(ws), 1000);
  })
  .onPlayedStream((event, ws) => {
    const state = connectionState.get(ws);
    if (state) {
      if (state.speakTimer) clearTimeout(state.speakTimer);
      state.isSpeaking = false;
      logger.info({ name: event.name, callId: state?.callUuid }, "Playback confirmed — now listening");
    }
  })
  .onClearedAudio((event, ws) => {
    const state = connectionState.get(ws);
    if (state) state.isSpeaking = false;
  })
  .onError((error, ws) => {
    logger.error({ err: error.message }, "Stream SDK error");
  })
  .onClose((ws) => {
    const state = connectionState.get(ws);
    if (state?.silenceTimer) clearTimeout(state.silenceTimer);
    if (state?.speakTimer) clearTimeout(state.speakTimer);
    logger.info({ callId: state?.callUuid }, "Connection closed");
  })
  .start();

// ─── Turn Processing ─────────────────────────────────────────────────────

async function processTurn(ws) {
  const state = connectionState.get(ws);
  if (!state || state.isProcessing || state.audioBuffer.length === 0) return;

  state.isProcessing = true;
  const chunks = state.audioBuffer;
  state.audioBuffer = [];

  try {
    // Combine audio chunks
    const raw = Buffer.concat(chunks);
    if (raw.length < 8000) { state.isProcessing = false; return; } // less than 1 sec = noise

    // STT
    const userText = await transcribeAudio(raw, { encoding: "audio/x-mulaw", sampleRate: 8000 });
    if (!userText || userText.trim().length < 2) { state.isProcessing = false; return; }

    // Filter Whisper hallucinations (garbage text from noise/echo)
    if (isHallucination(userText)) {
      logger.debug({ userText, callId: state.callUuid }, "Hallucination filtered");
      state.isProcessing = false;
      return;
    }

    logger.info({ userText, callId: state.callUuid }, "User said");
    appendTranscript(state.callUuid, "user", userText);

    // LLM
    state.conversation.push({ role: "user", content: userText });
    const reply = await generateResponse(state.conversation);
    state.conversation.push({ role: "assistant", content: reply });

    logger.info({ reply: reply.slice(0, 80), callId: state.callUuid }, "AI reply");
    appendTranscript(state.callUuid, "assistant", reply);

    // TTS + Play via SDK
    const audio = await synthesizeSpeech(reply);
    if (audio && plivoServer.isActive(ws)) {
      sendAudio(ws, state, audio, `reply_${Date.now()}`);
    }
  } catch (err) {
    logger.error({ err: err.message, callId: state.callUuid }, "Turn error");
  }

  state.isProcessing = false;
}

/**
 * Send audio and manage isSpeaking flag with a TIMER FALLBACK.
 *
 * Critical: we do NOT rely only on Plivo's playedStream event to release
 * isSpeaking (it may not fire reliably). We also set a timer based on the
 * audio's actual duration so the AI always resumes listening.
 * mulaw 8kHz = 8000 bytes/sec.
 */
function sendAudio(ws, state, audio, name) {
  state.isSpeaking = true;
  plivoServer.playAudio(ws, "audio/x-mulaw", 8000, audio);
  plivoServer.checkpoint(ws, name);

  const durationMs = Math.ceil((audio.length / 8000) * 1000);
  // Fallback: release isSpeaking after playback duration + 400ms buffer
  if (state.speakTimer) clearTimeout(state.speakTimer);
  state.speakTimer = setTimeout(() => {
    if (state.isSpeaking) {
      state.isSpeaking = false;
      logger.info({ name, callId: state.callUuid }, "isSpeaking released by timer fallback");
    }
  }, durationMs + 400);

  logger.info({ bytes: audio.length, durationMs, name, callId: state.callUuid }, "Audio sent");
}


// ─── Whisper Hallucination Filter ────────────────────────────────────────

/**
 * Whisper hallucinates on silence/noise/echo. Reject common garbage outputs.
 */
function isHallucination(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();

  // Known Whisper hallucinations
  const hallucinations = [
    "thank you", "thank you.", "thanks for watching", "bye", "hello",
    "shabbat shalom", "you", "so", "okay", "ok", "the end",
    "thanks for listening", "see you next time", "subscribe",
    "why do you think i had that", "i don't know", "what",
    "hmm", "um", "uh", "...", "i'm sorry",
  ];
  if (hallucinations.includes(t)) return true;

  // Repeated single word: "hello hello hello"
  const words = t.replace(/[.,!?]/g, "").split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const unique = new Set(words);
    if (unique.size <= 2) return true;
  }

  // Only punctuation or too short
  if (t.replace(/[.,!?\s]/g, "").length < 3) return true;

  // English-only nonsense (user speaks Hindi/Hinglish, pure English short phrases are likely hallucination from noise)
  const looksLikeNonsense = /^(why|what|how|where|when|who|do you|did you|i had|i think|the)\b/.test(t) && words.length <= 8 && !t.match(/codeskate|plan|price|subscription|help|kaise|kya|mujhe|batao|chahiye/i);
  if (looksLikeNonsense) return true;

  return false;
}
