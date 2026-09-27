# Jester Voice — Handoff

## Product intent

Jester Voice is a new Discord voice bot/service for natural, continuous spoken conversation. The experience should feel closer to a live ChatGPT-style voice conversation than to a record/transcribe/respond bot.

The user already has `Pu11en/ebi-agent-chat-relay`. That project includes one-way voice recording/transcription behavior. Jester Voice is deliberately separate because converting a batch Whisper recorder into a full-duplex realtime system would create unnecessary coupling.

## Desired user experience

1. User joins a designated Discord voice channel.
2. Jester joins automatically or via `/join`.
3. User speaks normally without push-to-talk commands directed at the bot.
4. Jester hears streaming audio and begins responding with low latency.
5. User can interrupt Jester naturally; playback stops/cancels and the new utterance becomes the active turn.
6. Jester can delegate real tasks to EBI while keeping the conversation coherent.
7. Long-running EBI work should not freeze the voice experience. Jester can acknowledge/defer, then incorporate the returned result when ready.

Example:

> "Open the Aldus project and see where we left off."

Jester should conversationally acknowledge the request, delegate retrieval/work to EBI, and speak the useful result when the backend returns it.

## Architectural decisions already made

- New service/repo rather than rewriting the existing EBI Discord recorder.
- Discord remains the user-facing voice transport.
- OpenAI live/realtime voice handles the conversational audio loop.
- Existing EBI remains the work/agent backend.
- Use a clean adapter boundary between the live conversation and EBI.
- Credentials are supplied locally/runtime only, never committed.
- Server-side realtime connection is the intended deployment shape.

## User-supplied prerequisites

The user should only need to create/provide:

1. A new Discord application/bot and its bot token.
2. An OpenAI project API key with access to the required live/realtime model.

Expected `.env`:

```env
DISCORD_TOKEN=
OPENAI_API_KEY=
```

Optional configuration can be added later for guild/channel IDs, voice/model selection, EBI endpoint, etc., but V1 should avoid making setup unnecessarily complicated.

## Discord requirement

Discord's modern voice stack requires DAVE-compatible bot voice handling. Verify current library support before choosing the Discord voice implementation. Do not blindly copy the voice dependency choices from the old recorder.

## Implementation priorities

### Phase 1 — voice loop
- Discord login and slash-command registration.
- Join/leave voice channel.
- Receive/decode user voice audio.
- Resample/packetize into the format expected by OpenAI live voice.
- Maintain a realtime OpenAI session.
- Stream generated audio back into Discord.
- Implement interruption/cancellation.
- `/reset` starts a clean conversational session.

### Phase 2 — robustness
- Voice activity/turn handling.
- Connection recovery.
- Backpressure and audio queues.
- Avoid Jester hearing/re-ingesting its own playback.
- Session lifecycle and idle cleanup.
- Structured logging and useful error messages.

### Phase 3 — EBI delegation
- Define a narrow `EbiAdapter` interface.
- Convert appropriate conversational requests into EBI jobs/actions.
- Return structured EBI results into the live session.
- Preserve project/context selection.
- Never give the live model unrestricted shell/tool access merely for convenience.

### Phase 4 — polish
- `/status`, `/project`, `/mute`.
- Optional transcript/debug channel.
- Deployment/container configuration.
- Cost/session observability.

## Definition of V1 success

A user can clone the repo, add `DISCORD_TOKEN` and `OPENAI_API_KEY`, install dependencies, start the process, invite the bot, join a Discord voice channel, and have a stable two-way spoken conversation where interruption works.

EBI delegation may initially be a well-defined stub/adapter if the exact integration surface is not yet finalized, but the voice architecture must be designed so adding EBI does not require rewriting the audio loop.

## Non-goals

- Rebuilding EBI itself.
- Replacing `ebi-agent-chat-relay`.
- Batch record-then-transcribe as the primary conversational architecture.
- Committing API keys/tokens.
- Premature multi-user/multi-guild scaling before one-user V1 is solid.

## When continuing from a coding agent

Read this file, `README.md`, and `ARCHITECTURE.md` first. Verify current OpenAI live/realtime SDK/API and Discord DAVE-compatible voice library behavior against official documentation before pinning dependencies or implementing protocol details that may have changed.
