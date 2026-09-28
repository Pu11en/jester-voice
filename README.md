# Jester Voice

A low-latency conversational Discord voice interface for the existing EBI/ccdb agent system.

## Goal

The target experience is simple: join the designated Discord voice room and talk naturally. Jester should feel as close as practical to current ChatGPT Voice behavior—natural turn-taking, contextual follow-ups, concise spoken responses, streaming speech, and immediate barge-in—while adding voice control over EBI sessions.

Jester is a separate service. It does not replace EBI and it is not a rewrite of the existing one-way EBI voice/transcript extension.

## Current Phase 1 build

Jester joins the configured Discord room when the owner enters, listens and speaks through the local GPU speech worker, and uses the Codex app-server for replies. EBI session control is a separate Phase 2 plan.

## Local owner trial

1. Install Node 22.12 or newer and run `npm ci` in this project.
2. Copy `.env.example` to `.env`. The bot token and owner ID are read from the EBI env file; set the Discord room IDs in `.env` or use the old `VOICE_*` IDs from `~/.local/share/drew-ai-voice-transcripts/voice.env`.
3. Check that the benchmark Python environment and speech models named in `.env.example` exist, and that the old voice bot is not connected to the room.
4. Run `npm start`, then join the configured Discord voice room. Press Ctrl+C to stop Jester cleanly.

The systemd unit in `deploy/jester-voice.service` is provided for a later owner-managed setup; it is not enabled by this build. Do not run Jester and the old voice bot in the same server voice room at once.

Before relying on it, the owner still needs to try the local voice room and check conversational timing, barge-in, and Discord permissions. The automated check only syntax-checks the live smoke scripts; it never connects to Discord or calls the model.

## Design and references

The selected Phase 1 components are Parakeet, Silero + Smart Turn, Kokoro, and the Codex app-server. See `HANDOFF.md` and `REPLACES_OLD_VOICE.md` for the source specifications and benchmarks.

## Important decisions

- No GPT-Live/API-minute architecture for V1; it was rejected on cost.
- Prefer the owner's Codex subscription with GPT-6 Luna for Jester's conversational brain.
- No automatic brain fallback chain in V1.
- EBI owns canonical session/history/project state. Jester queries and controls it through typed interfaces.
- Current One Piece tags are temporary human-friendly addresses; resolve them to canonical session IDs.
- Owner gets priority and privileged EBI control; guests may converse and can receive temporary scoped permissions from the owner.
- Jester proactively surfaces meaningful agent events without constantly polling the brain.
- Crash/restart recovery is first-class.
- Existing EBI voice code is reference/evidence, not the Jester specification.

## Local setup philosophy

Inspect first, install second. Reuse existing working Docker/Node/Python/FFmpeg/STT/model installations where sensible. Keep `.env` and credentials out of git.

The exact runtime configuration will be finalized after the machine and EBI interfaces are inspected. `.env.example` therefore contains only stable configuration concepts, not an obsolete OpenAI API key requirement.

## Success criterion

`It runs` is not enough. The owner should be able to talk naturally for 10–15 minutes without consciously adapting speech for the bot. If the owner has to use rigid commands, avoid pauses, wait unnaturally, repeat constantly, or hesitate to interrupt, the implementation has not reached the target quality bar.
