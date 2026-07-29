/**
 * Environment configuration — single source of truth for all env vars.
 */

import "dotenv/config";

export const config = {
  port: Number(process.env.PORT) || 8080,
  nodeEnv: process.env.NODE_ENV || "development",

  // Plivo
  plivo: {
    authId: process.env.PLIVO_AUTH_ID || "",
    authToken: process.env.PLIVO_AUTH_TOKEN || "",
    phoneNumber: process.env.PLIVO_PHONE_NUMBER || "",
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
  },

  // AI Agent
  agent: {
    language: process.env.AI_AGENT_LANGUAGE || "hi-IN",
    voice: process.env.AI_AGENT_VOICE || "alloy",
    fillerEnabled: process.env.AI_FILLER_ENABLED !== "false",
  },

  // Public URL for webhooks
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${Number(process.env.PORT) || 8080}`,
};
