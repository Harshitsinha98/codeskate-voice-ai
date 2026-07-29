/**
 * Text-to-Speech (TTS) — OpenAI TTS API.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function synthesizeSpeech(text) {
  try {
    if (!text || text.trim().length === 0) return null;

    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: config.agent.voice,
      input: text,
      response_format: "pcm",
      speed: 1.0,
    });

    const arrayBuffer = await response.arrayBuffer();
    const pcm24k = Buffer.from(arrayBuffer);
    return pcm24kToMulaw8k(pcm24k);
  } catch (err) {
    logger.error({ err: err.message }, "TTS synthesis failed");
    return null;
  }
}

function pcm24kToMulaw8k(pcm24k) {
  const sampleCount24k = pcm24k.length / 2;
  const downsampleFactor = 3;
  const sampleCount8k = Math.floor(sampleCount24k / downsampleFactor);
  const mulaw = Buffer.alloc(sampleCount8k);

  for (let i = 0; i < sampleCount8k; i++) {
    const srcIndex = i * downsampleFactor * 2;
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
