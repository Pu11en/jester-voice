# Jester Voice

A low-latency conversational Discord voice interface for the existing EBI/ccdb agent system.

## Goal

The target experience is simple: join the designated Discord voice room and talk naturally. Jester should feel as close as practical to current ChatGPT Voice behavior—natural turn-taking, contextual follow-ups, concise spoken responses, streaming speech, and immediate barge-in—while adding voice control over EBI sessions.

Jester is a separate service. It does not replace EBI and it is not a rewrite of the existing one-way EBI voice/transcript extension.

## Current design

```text
Discord voice
    <->
Jester voice/conversation layer
    <->
Codex subscription / GPT-6 Luna (brain candidate)
    <->
Deterministic Jester Control
    <->
Existing EBI / ccdb sessions, tools, projects and events
```

The final local voice engine/components are intentionally NOT pinned yet. The coding session must inspect the owner's Lenovo, run AllGit research, and benchmark viable open-source realtime voice stacks/components before committing.

See `HANDOFF.md` for the source-of-truth product and engineering specification.

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
