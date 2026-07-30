/**
 * Text-to-Speech — OpenAI TTS API.
 *
 * Generates natural human-like audio and stores as WAV files in memory.
 * Plivo fetches these via /audio/:id endpoint using <Play> element.
 *
 * No WebSocket needed — Plivo downloads the audio file over HTTP.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// In-memory audio cache (auto-cleanup after 5 min)
const audioCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Generate speech audio and store it. Returns an ID to fetch via /audio/:id.
 *
 * @param {string} text - Text to speak
 * @returns {string} Audio ID (use with /audio/:id endpoint)
 */
export async function synthesizeSpeechToFile(text) {
  try {
    if (!text || text.trim().length === 0) throw new Error("Empty text");

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts", // Newer, more natural/expressive voice
      voice: config.agent.voice, // "nova" — warm natural female
      input: text,
      response_format: "mp3", // Plivo supports mp3 via <Play>
      instructions: "Speak in a warm, friendly, natural Indian customer-care tone. Sound like a real human, conversational and casual. This is Hindi/Hinglish.",
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Store with unique ID
    const id = crypto.randomUUID();
    audioCache.set(id, { buffer, contentType: "audio/mpeg", createdAt: Date.now() });

    // Auto-cleanup old entries
    cleanupCache();

    logger.debug({ id, size: buffer.length, text: text.slice(0, 50) }, "TTS audio generated");
    return id;
  } catch (err) {
    logger.error({ err: err.message }, "TTS synthesis failed");
    throw err;
  }
}

/**
 * Get audio buffer by ID (called by /audio/:id route).
 */
export function getAudioById(id) {
  return audioCache.get(id) || null;
}

/**
 * Remove expired audio files from cache.
 */
function cleanupCache() {
  const now = Date.now();
  for (const [id, entry] of audioCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      audioCache.delete(id);
    }
  }
}



/**
 * Synthesize speech and return raw mulaw buffer (for WebSocket streaming mode).
 * Used by voiceStreamHandler.js to send audio directly over WebSocket.
 */
export async function synthesizeSpeech(text) {
  try {
    if (!text || text.trim().length === 0) return null;

    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: config.agent.voice,
      input: text,
      response_format: "pcm", // Raw PCM 24kHz 16-bit mono
      speed: 1.05,
    });

    const arrayBuffer = await response.arrayBuffer();
    const pcm24k = Buffer.from(arrayBuffer);

    // Plivo stream is "audio/x-l16" at 8kHz → downsample 24kHz→8kHz, keep 16-bit PCM
    return pcm24kToL16_8k(pcm24k);
  } catch (err) {
    logger.error({ err: err.message }, "synthesizeSpeech failed");
    return null;
  }
}

/**
 * Convert PCM 24kHz 16-bit mono → L16 PCM 8kHz 16-bit mono (little-endian).
 * Plivo bidirectional stream uses "audio/x-l16" at 8kHz.
 */
function pcm24kToL16_8k(pcm24k) {
  const sampleCount24k = Math.floor(pcm24k.length / 2);
  const downsampleFactor = 3; // 24000 / 8000
  const sampleCount8k = Math.floor(sampleCount24k / downsampleFactor);
  const out = Buffer.alloc(sampleCount8k * 2);

  for (let i = 0; i < sampleCount8k; i++) {
    const srcIndex = i * downsampleFactor * 2;
    if (srcIndex + 1 >= pcm24k.length) break;
    const sample = pcm24k.readInt16LE(srcIndex);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}
