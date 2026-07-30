/**
 * LLM — GPT-4.1-nano for conversational AI.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function generateResponse(messages) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Better Hindi/Hinglish conversation than nano
      messages,
      temperature: 0.6,
      max_tokens: 120, // Short responses for natural phone conversation
    });
    return response.choices[0]?.message?.content || "Maaf kijiye, main samajh nahi paaya. Kya aap dobara bol sakte hain?";
  } catch (err) {
    logger.error({ err: err.message }, "LLM generation failed");
    return "Ek technical samasya aa gayi hai. Kripya thodi der baad try karein.";
  }
}
