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
      speed: 1.0,
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
