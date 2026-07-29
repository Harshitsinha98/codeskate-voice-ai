/**
 * Speech-to-Text (STT) — OpenAI Whisper API.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

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

    return response?.trim() || null;
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
