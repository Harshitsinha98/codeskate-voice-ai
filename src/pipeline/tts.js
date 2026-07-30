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
      model: "tts-1",
      voice: config.agent.voice, // "alloy" — natural human voice
      input: text,
      response_format: "mp3", // Plivo supports mp3 via <Play>
      speed: 1.1, // Slightly faster — feels more responsive on phone
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
      speed: 1.1,
    });

    const arrayBuffer = await response.arrayBuffer();
    const pcm24k = Buffer.from(arrayBuffer);

    // Downsample 24kHz → 8kHz and encode as mulaw for Plivo
    return pcm24kToMulaw8k(pcm24k);
  } catch (err) {
    logger.error({ err: err.message }, "synthesizeSpeech failed");
    return null;
  }
}

/**
 * Convert PCM 24kHz 16-bit mono → mulaw 8kHz mono.
 */
function pcm24kToMulaw8k(pcm24k) {
  const sampleCount24k = pcm24k.length / 2;
  const downsampleFactor = 3;
  const sampleCount8k = Math.floor(sampleCount24k / downsampleFactor);
  const mulaw = Buffer.alloc(sampleCount8k);

  for (let i = 0; i < sampleCount8k; i++) {
    const srcIndex = i * downsampleFactor * 2;
    if (srcIndex + 1 >= pcm24k.length) break;
    const sample = pcm24k.readInt16LE(srcIndex);
    mulaw[i] = linearToMulaw(sample);
  }
  return mulaw;
}

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  let mask = 0x4000;
  while (exponent > 0 && (sample & mask) === 0) { exponent--; mask >>= 1; }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}
