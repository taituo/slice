# Phone calls with ElevenLabs Agents

Callers talk to the **same deep agent** as the chat, A2A and MCP. There are two ways to wire it; pick one.

## Option A (recommended): our agent is the agent's LLM

ElevenLabs handles the phone line, speech-to-text and the voice; every turn is answered by our
platform agent through an OpenAI-compatible endpoint.

1. In the ElevenLabs dashboard, create an agent and set **LLM → Custom LLM**:
   - Server URL: `https://YOUR_API_HOST/v1/voice/llm` (ElevenLabs appends `/chat/completions`)
   - API key: the value of `VOICE_LLM_KEY`
   - Turn on sending extra body (`elevenlabs_extra_body`) and pass `caller_id = {{system__caller_id}}`
     and `conversation_id = {{system__conversation_id}}`, so returning customers are recognised and
     memory is kept per call.
2. Import a Twilio number under **Phone Numbers** and assign it to the agent for inbound calls.
3. Set `VOICE_TENANT` to the tenant the line belongs to (`slice`, `flexgym`, or `nearby`).

## Option B: ElevenLabs runs its own LLM and calls our tools

Import the tools in `server-tools.json` (generated from the shared tool catalogue). Each tool posts
to `/v1/voice/tools/<name>` with the `x-voice-secret` header (`VOICE_TOOL_SECRET`).

## Outbound calls

Order updates, class reminders and support callbacks with channel `call` are placed through
`POST /v1/convai/twilio/outbound-call` (agent id, phone number id, number to call, and dynamic
variables `purpose` and `message`). Set:

```
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_PHONE_NUMBER_ID=...
```

Without them, calls are logged as `dry_run` in `voice_calls`.

## Post-call webhook

Point the workspace's post-call webhook at `/v1/voice/elevenlabs/post-call` and put its signing
secret in `ELEVENLABS_WEBHOOK_SECRET`. The `ElevenLabs-Signature: t=…,v0=…` header is verified
(HMAC-SHA256 over `timestamp.body`, 30-minute window). Calls marked unsuccessful, or whose summary
mentions a complaint, open a support case automatically.
