# Architecture

## Components

```text
Discord Gateway / Voice
  |  incoming user audio
  v
DiscordAudioIngress
  |  normalized PCM/audio frames
  v
LiveSession ------------------------------+
  |                                       |
  | OpenAI realtime events               | tool/delegation requests
  v                                       v
OpenAI Live Voice                    EbiAdapter
  |                                       |
  | generated audio / events              v
  v                                  Existing EBI
DiscordAudioEgress                       |
  |                                       |
  +-------------- spoken result <---------+
```

## Separation of concerns

### Discord layer
Owns Discord authentication, commands, voice channel lifecycle, current Discord voice encryption requirements, inbound user audio, and outbound bot audio.

### Live session layer
Owns one active conversational session, OpenAI realtime connection, turn/interruption state, audio queues, session reset, and conversion between Discord audio and API audio formats.

### EBI adapter
Owns delegation into the existing EBI system. It should expose a small typed interface rather than leaking EBI internals into the audio code.

Illustrative interface:

```ts
export interface EbiAdapter {
  run(input: {
    request: string;
    project?: string;
    conversationId: string;
  }): Promise<{
    summary: string;
    data?: unknown;
  }>;
}
```

This exact signature can change after inspecting the live EBI integration surface; the architectural boundary should not.

## Interruption model

When user speech begins while Jester is speaking:

1. Detect/receive the new user turn.
2. Cancel/truncate the active generated response according to the current OpenAI realtime protocol.
3. Immediately stop/clear queued Discord playback associated with the cancelled response.
4. Continue sending the new user audio.
5. Keep conversation state aligned with what the user actually heard.

This is a core requirement, not optional polish.

## Audio rules

- Avoid repeated disk writes in the realtime path.
- Keep the pipeline streaming and bounded.
- Resample only where required.
- Do not feed the bot's own output back as user input.
- Apply bounded queues/backpressure so a slow network does not grow memory indefinitely.
- Prefer explicit frame timestamps/sequence tracking where the selected Discord voice library makes them available.

## Session model

Start simple: one active Discord voice context per bot process for V1. Design classes so per-guild sessions can be introduced later without global mutable audio state.

A session owns:

- Discord guild/channel/user context
- OpenAI realtime connection
- current project/context selection
- inbound audio queue
- outbound playback queue
- current response/cancellation state
- timestamps/health metrics

## Failure behavior

- Discord disconnect: stop audio cleanly and attempt bounded reconnect where appropriate.
- OpenAI disconnect: stop claiming the bot is listening/responding; reconnect and create a fresh/continued session according to supported API semantics.
- EBI task failure: return a concise conversational error without killing the voice session.
- Missing credentials: fail fast at startup with the missing variable name, never print secret values.

## Security

- `.env` ignored.
- Never log bot tokens/API keys/auth headers.
- EBI delegation should use allowlisted operations/capabilities.
- Treat spoken user input as untrusted input.
- Avoid arbitrary shell execution from model-generated strings.

## Deployment

V1 should run locally first. Add Docker support after the local loop is proven. The service needs stable outbound network access and a Discord voice implementation compatible with Discord's current encrypted voice/DAVE requirements.
