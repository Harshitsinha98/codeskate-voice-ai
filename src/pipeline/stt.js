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
 * Transcribe raw audio buffer from Plivo WebSocket (real-time mode).
 * Handles the media format Plivo declares in the start event.
 *
 * @param {Buffer} rawBuffer - raw audio bytes from Plivo media events
 * @param {{encoding: string, sampleRate: number}} mediaFormat
 */
export async function transcribeAudio(rawBuffer, mediaFormat = {}) {
  try {
    const sampleRate = mediaFormat.sampleRate || 8000;

    // SDK gives raw mulaw audio — wrap as mulaw WAV for Whisper
    const wavBuffer = wrapWav(rawBuffer, sampleRate, 7, 8); // format 7 = mu-law, 8-bit

    const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

    const response = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: "en", // Hinglish -> romanized (better than garbled Devanagari)
      response_format: "text",
      prompt: "Phone call in Hinglish. Words: Codeskate, plan, pricing, subscription, growth, starter, WhatsApp, CRM, lead, demo, kitna, chahiye, batao, haan, nahi.",
    });

    return (typeof response === "string" ? response : response?.text || "").trim() || null;
  } catch (err) {
    logger.error({ err: err.message }, "Whisper STT (stream) failed");
    return null;
  }
}

/**
 * Wrap raw audio in a WAV container.
 * @param audioFormat 7 = mu-law, 1 = PCM
 * @param bitsPerSample 8 for mulaw, 16 for PCM
 */
function wrapWav(rawBuffer, sampleRate, audioFormat, bitsPerSample) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = rawBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawBuffer]);
}
