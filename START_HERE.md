# START HERE — Coding Session Checklist

Do not begin by installing random dependencies or scaffolding the whole product.

## 1. Read the specification

Read, in order:
1. `HANDOFF.md` — source of truth.
2. `ARCHITECTURE.md` — component boundaries.
3. `README.md` — short project orientation.

If another repo file conflicts with `HANDOFF.md`, follow `HANDOFF.md` and fix the stale file.

## 2. Inspect the machine before changing it

Record:
- Windows/WSL setup;
- CPU;
- RAM;
- GPU + VRAM;
- Docker version/resources;
- Node/Python/FFmpeg versions;
- CUDA/Vulkan/other acceleration actually available;
- existing Whisper/faster-whisper/STT models and environments;
- existing Codex CLI/install/auth state;
- current EBI/ccdb runtime locations and how it is launched.

Do not reinstall working heavy components merely to standardize them.

## 3. Inspect EBI interfaces

Inspect `Pu11en/ebi-agent-chat-relay` and the runtime version actually used on this machine.

Focus on:
- current control-plane endpoints;
- canonical session/thread IDs;
- One Piece voice tag assignment/resolution;
- `/api/threads/{id}/spoken` or its current replacement;
- create/stop/status/model/backend operations;
- event/status mechanisms;
- `extensions/voice_transcripts` ONLY as implementation reference.

Document the actual integration surface before writing `EbiAdapter`.

## 4. Run AllGit research locally

Use `Pu11en/all-git` and its `search_repos` tool/CLI. Search the jobs listed in `HANDOFF.md` plus any more precise queries suggested by results.

For promising repos record:
- repo URL;
- license;
- maintenance/activity;
- Windows/Docker compatibility;
- CPU/GPU requirements;
- streaming support;
- interruption/barge-in support;
- integration complexity;
- what code/components can actually be reused.

Do not select by stars alone.

## 5. Benchmark voice approaches BEFORE building EBI control

Compare at least:

### Candidate A
A reusable realtime open-source voice engine such as Hugging Face `speech-to-speech`, adapted to Discord + Codex + Jester Control.

### Candidate B
A purpose-built pipeline using the strongest benchmarked VAD/end-of-turn/STT/TTS components, including the existing EBI faster-whisper setup where useful.

The candidate list is not sacred. AllGit/research may surface better options.

## 6. Prove the brain bridge

Use the owner's Codex subscription with GPT-6 Luna candidate.

Measure:
- authentication/reconnect behavior;
- first-token latency;
- streaming output;
- structured/typed action reliability;
- practical subscription usage;
- conversational response quality.

Do NOT silently switch to paid OpenAI API billing if this is awkward. Report the actual limitation and solve the subscription path first.

## 7. Build the smallest real loop

Before full EBI integration, prove:

```text
Discord per-user audio
-> turn detection
-> STT
-> Codex/Luna
-> streaming TTS
-> Discord playback
```

Required demonstrations:
- owner can talk naturally;
- thinking pauses are not constantly cut off;
- Jester starts responding quickly after a real completed turn;
- owner can interrupt Jester and playback stops immediately;
- Jester can continue coherently after interruption;
- owner/guest speaker identity is known;
- machine load remains acceptable alongside normal EBI usage.

If this loop does not feel good, DO NOT hide the problem by proceeding to more features. Fix/replace the failing component first.

## 8. Only then build Jester Control + EBI integration

Implement deterministic authorization and typed EBI operations from `HANDOFF.md`.

## 9. Acceptance test

Final acceptance is not a unit-test-only milestone.

The owner should talk naturally to Jester for 10–15 minutes while using real EBI sessions. The build fails the experience goal if the owner must consciously adapt speech for the bot.

## Owner inputs that may be needed during implementation

Ask only when actually required:
- Discord bot token/application setup;
- Discord guild/voice-channel IDs if not discoverable/configured;
- confirmation/login for Codex subscription auth;
- any EBI control secret not already present locally;
- subjective choice between voice candidates after real audio samples are available.

Do not ask the owner to make technical choices that can be settled by measurement or research.
