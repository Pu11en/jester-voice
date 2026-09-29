# Jester Voice

> **Current status, known problems and how to test: [STATUS-2026-09-29.md](STATUS-2026-09-29.md).**

A low-latency conversational Discord voice interface for the existing EBI/ccdb agent system.

## Goal

The target experience is simple: join the designated Discord voice room and talk naturally. Jester should feel as close as practical to current ChatGPT Voice behavior—natural turn-taking, contextual follow-ups, concise spoken responses, streaming speech, and immediate barge-in—while adding voice control over EBI sessions.

Jester is a separate service. It does not replace EBI and it is not a rewrite of the existing one-way EBI voice/transcript extension.

## Current Phase 1 build

Jester joins the configured Discord room when the owner enters, listens and speaks through the local GPU speech worker, and uses the Codex app-server for replies. EBI session control is a separate Phase 2 plan.

## Use Jester now

The local Drew-only attention slice starts dormant on each join: room speech is
still transcribed, but only Drew can wake replies by starting with "Jester" or
"Hey Jester". Name-free follow-ups work for 60 seconds after an accepted turn or
the end of Jester's spoken answer. Guest speech, tentative pauses, and explicit
side talk (such as "Hey Alex, ...", "Guys, ...", or "I'm talking to Alex") do not
extend that window. "That's all", "Thanks, Jester", "Goodbye", or "Never mind"
end the exchange immediately. After an ending or lull, say Jester again; a bare
"Zoro, ..." cannot wake it. Guest speech never reaches Luna in this slice.

Say "Jester, just listen" to stop Jester's speech and keep recording room
transcripts without replies. Only Drew can switch modes. "Jester, talk again"
restores dormant conversation, so say Jester again for the next question. Owner
leave controls still work in either mode. The mode resets after Drew leaves the
room; a transport reconnect during the same visit keeps transcript-only mode.
The mode gate does not stop audio capture, leaving room for a later recording
Pause control to override capture itself.

This is a deterministic text gate, not a semantic addressee detector: unmarked
owner speech within the follow-up window is treated as a follow-up. The 60-second
window and recognition phrases still need Drew's live feel check. These local
changes do not restart or update the running service.

As of 2026-09-28, `jester-voice.service` is enabled and running on Drew's computer. Join the configured Discord voice room; Jester auto-joins when the owner enters. Say "Jester, can you hear me?" and talk naturally. To make it leave for the rest of that visit, say "Jester, leave" or type `!jester leave` in the transcript channel. Type `!jester join` there to bring it back while you are in the room.

Jester uses the existing DrewAI bot account, token and owner ID from the EBI env file. It reads room IDs from the old voice settings when no Jester `.env` is present. The old `drew-ai-voice-transcripts.service` is disabled and archived; do not run both voice services in the same server at once. The main EBI Discord bot still runs separately.

Manage Jester with `systemctl --user status|restart|stop jester-voice.service`; logs are in `journalctl --user -u jester-voice.service`. The source unit is `deploy/jester-voice.service` and the installed user unit is `~/.config/systemd/user/jester-voice.service`.

The first real conversation still needs the owner's feel check for timing, barge-in and Discord permissions. Offline checks pass, and service startup loaded the speech models and connected to Discord. EBI session control is Phase 2.

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
