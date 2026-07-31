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
        state.isSpeaking = true;
        plivoServer.playAudio(ws, "audio/x-mulaw", 8000, audio);
        plivoServer.checkpoint(ws, "greeting");
        logger.info({ bytes: audio.length, callId: state.callUuid }, "Greeting sent via SDK");
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
    state.silenceTimer = setTimeout(() => processTurn(ws), 700);
  })
  .onPlayedStream((event, ws) => {
    const state = connectionState.get(ws);
    if (state) {
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
    if (raw.length < 4000) { state.isProcessing = false; return; } // too short

    // STT
    const userText = await transcribeAudio(raw, { encoding: "audio/x-mulaw", sampleRate: 8000 });
    if (!userText || userText.trim().length < 2) { state.isProcessing = false; return; }

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
      state.isSpeaking = true;
      plivoServer.playAudio(ws, "audio/x-mulaw", 8000, audio);
      plivoServer.checkpoint(ws, `reply_${Date.now()}`);
    }
  } catch (err) {
    logger.error({ err: err.message, callId: state.callUuid }, "Turn error");
  }

  state.isProcessing = false;
}
