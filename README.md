# Codeskate Voice AI

AI-powered phone calling SaaS — customers call your business number, AI answers instantly in Hindi/English.

## Architecture

```
Customer calls +91 number
         ↓
   Plivo (₹0.60/min telephony)
         ↓ WebSocket audio stream
   ┌─────────────────────────────────┐
   │   Codeskate Voice AI Server     │
   │                                  │
   │   Audio → Whisper STT → Text    │
   │   Text  → GPT-4.1-nano → Reply │
   │   Reply → OpenAI TTS → Audio   │
   │                                  │
   │   + Filler words ("Ji...")      │
   │   + Barge-in detection          │
   │   + Silence detection (VAD)     │
   └─────────────────────────────────┘
         ↓ Audio stream back
   Plivo → Customer hears AI response
```

## Cost per minute: ~₹1.60

| Component | Cost |
|-----------|------|
| Plivo telephony | ₹0.60/min |
| Whisper STT | ~₹0.50/min |
| GPT-4.1-nano | ~₹0.03/min |
| OpenAI TTS | ~₹0.50/min |

## Quick Start

```bash
git clone https://github.com/Harshitsinha98/codeskate-voice-ai.git
cd codeskate-voice-ai
npm install
cp .env.example .env
# Fill in your API keys
npm start
```

## Setup

1. **Plivo**: Sign up → Get Auth ID + Token → Buy Indian number ($2/mo)
2. **OpenAI**: Get API key (you already have one)
3. **Deploy**: Render/Railway/any Node.js host
4. **Webhook**: Set Plivo Answer URL to `https://your-domain.com/plivo/inbound`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/plivo/inbound` | Inbound call webhook |
| POST | `/plivo/status` | Call status callback |
| POST | `/plivo/outbound` | Initiate outbound AI call |
| GET | `/api/calls` | List recent calls |
| GET | `/api/calls/:id` | Call details + transcript |
| GET | `/api/stats` | Call statistics |

## Project Structure

```
src/
├── server.js                    # Express + WebSocket server
├── config/
│   ├── env.js                   # Environment variables
│   └── logger.js                # Pino logger
├── pipeline/
│   ├── voiceStreamHandler.js    # Main voice pipeline
│   ├── stt.js                   # Whisper Speech-to-Text
│   ├── llm.js                   # GPT-4.1-nano
│   └── tts.js                   # OpenAI TTS + mulaw encoding
├── routes/
│   ├── plivo.js                 # Plivo webhooks
│   └── callLogs.js              # Call logs API
└── services/
    ├── agentConfig.js           # AI agent personality
    └── callLogger.js            # Call log storage
```

## License

Private — Codeskate
