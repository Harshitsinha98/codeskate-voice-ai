/**
 * Speech-to-Text (STT) — OpenAI Whisper API.
 *
 * Two modes:
 * 1. transcribeFromUrl(url) — Download audio from Plivo recording URL, send to Whisper
 * 2. transcribeAudio(buffer) — Direct buffer transcription (for future WebSocket use)
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Download audio from a URL (Plivo recording) and transcribe with Whisper.
 *
 * @param {string} recordingUrl - URL to the audio file (Plivo provides this)
 * @returns {string|null} Transcribed text or null
 */
export async function transcribeFromUrl(recordingUrl) {
  try {
    if (!recordingUrl) return null;

    // Plivo recording URLs need auth to download
    const authHeader = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");

    // Download the recording
    const audioResponse = await fetch(recordingUrl, {
      headers: { Authorization: `Basic ${authHeader}` },
    });

    if (!audioResponse.ok) {
      logger.warn({ status: audioResponse.status, url: recordingUrl }, "Failed to download recording");
      return null;
    }

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    if (audioBuffer.length < 1000) {
      logger.debug("Recording too short, skipping transcription");
      return null;
    }

    // Send to Whisper
    const file = new File([audioBuffer], "recording.wav", { type: "audio/wav" });

    const response = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      // Use English mode — Whisper transcribes Hinglish/Hindi as romanized text
      // which GPT understands better than garbled Devanagari from phone audio.
      // Indian business calls are usually Hinglish (mix of Hindi + English).
      language: "en",
      response_format: "text",
      prompt: "This is a phone call in Hinglish (Hindi + English mix). Common words: subscription, plan, pricing, growth, starter, enterprise, CRM, WhatsApp, lead, follow-up, agent, hello, haan, nahi, theek hai, kitna, chahiye, karna hai, batao",
    });

    const text = typeof response === "string" ? response.trim() : response?.text?.trim() || "";
    return text || null;
  } catch (err) {
    logger.error({ err: err.message, url: recordingUrl }, "Whisper STT failed");
    return null;
  }
}

/**
 * Transcribe raw mulaw audio buffer (for WebSocket mode — future use).
 */
export async function transcribeAudio(mulawBuffer) {
  try {
    const wavBuffer = wrapMulawInWav(mulawBuffer, 8000);
    const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

    const response = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: config.agent.language.split("-")[0],
      response_format: "text",
    });

    return (typeof response === "string" ? response : response?.text || "").trim() || null;
  } catch (err) {
    logger.error({ err: err.message }, "Whisper STT failed");
    return null;
  }
}

function wrapMulawInWav(rawBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 8;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = rawBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawBuffer]);
}
