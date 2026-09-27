# Jester Voice — Architecture Direction

`HANDOFF.md` is the source of truth. This file captures the intended component boundaries without prematurely choosing every local voice dependency.

## High-level architecture

```text
Discord Voice
  |
  | per-user incoming audio / outgoing Jester audio
  v
Jester Voice Runtime
  |-- speaker identity / owner priority
  |-- VAD + end-of-turn detection
  |-- STT
  |-- streaming playback + barge-in
  |-- TTS
  |
  v
Conversation Runtime
  |-- recent conversational context
  |-- canonical resolved session references
  |-- BrainAdapter
  |      `-- Codex subscription / GPT-6 Luna candidate
  |
  v
Jester Control
  |-- authorization / temporary grants
  |-- typed action validation
  |-- event queue / proactive notifications
  |-- EBI adapter
  |
  v
Existing EBI / ccdb
  |-- sessions / threads
  |-- temporary One Piece tags
  |-- folders / projects
  |-- models / backends
  |-- history / memory
  `-- task/status events
```

## Core rule

The brain interprets. Deterministic code authorizes, resolves, validates, executes and verifies.

Do not let the LLM become the source of truth for current sessions, permissions, tags, task status or history.

## Voice engine boundary

Keep the voice runtime modular enough to support either:

1. a reusable open-source realtime speech pipeline/engine (evaluate Hugging Face `speech-to-speech` and strong AllGit discoveries), or
2. a purpose-built Jester pipeline assembled from benchmarked VAD/turn/STT/TTS components.

The machine benchmark decides. Do not force architecture because a candidate was mentioned during planning.

Required interfaces conceptually:

```ts
interface TurnDetector {
  pushAudio(frame: AudioFrame): Promise<TurnSignal[]>;
}

interface SpeechRecognizer {
  transcribe(turn: AudioTurn): Promise<Transcript>;
}

interface BrainAdapter {
  stream(input: BrainInput): AsyncIterable<BrainEvent>;
}

interface SpeechSynthesizer {
  stream(text: AsyncIterable<string> | string): AsyncIterable<AudioFrame>;
  cancel(): Promise<void>;
}
```

Exact language/signatures can change after benchmarking.

## Jester Control boundary

Jester Control should expose typed capabilities rather than arbitrary generated commands. Illustrative operations:

```ts
listActiveSessions()
resolveCurrentTag(tag)
getSessionStatus(sessionId)
messageSession(sessionId, message)
createSession(request)
stopSession(sessionId)
getRelevantHistory(query)
setSessionModel(sessionId, model)
setSessionBackend(sessionId, backend)
grantTemporaryPermission(grant)
revokeTemporaryPermission(grantId)
```

Only implement operations supported by current EBI/ccdb. Prefer adapting existing control-plane endpoints over duplicating EBI mechanics.

## Session references

A current spoken tag is resolved to a canonical session ID. Conversation context stores that canonical reference so pronouns remain safe even if tag assignment later changes.

Historical lookup does not assume tag persistence. It searches EBI history using the user's contextual clues.

## Interruption model

Barge-in is a first-class path:

1. detect real user speech while Jester is speaking;
2. stop outbound playback immediately;
3. cancel queued TTS/audio;
4. mark only actually-played response content as heard;
5. capture the new user turn;
6. continue conversation from that reality.

Do not wait for STT or brain completion before stopping playback.

## Event model

EBI should push or expose deterministic meaningful events. Do not poll the brain for status.

Jester queues events and delivers them based on priority and conversational timing. While the owner is absent, event collection should require no brain calls.

## Permissions

Authorization is based on Discord user identity.

Owner privileges and temporary guest grants live in deterministic state outside the LLM. A model-produced request is never sufficient authorization by itself.

## Persistence / recovery

Persist only state Jester cannot reconstruct safely. Canonical EBI/session truth is rebuilt from EBI after restart.

Likely Jester-owned persistence:
- temporary permission grants if they must survive a process crash within the same voice presence;
- queued meaningful events/catch-up state;
- minimal runtime/session metadata needed for recovery;
- observability/benchmark data.

Do not use LLM context as infrastructure persistence.

## Existing EBI voice code

Inspect `ebi-agent-chat-relay/extensions/voice_transcripts` for useful proven implementation details such as Discord receive, speaker separation, local faster-whisper and control-plane calls. It is reference material only. Jester's desired behavior comes from `HANDOFF.md`.

## Deployment

Local-first. Auto-restart is required because the owner's computer crashes/restarts frequently. Docker with an appropriate restart policy is a candidate, but choose the host/container split after inspecting Codex authentication and local acceleration.

Do not containerize merely for aesthetics if it harms GPU access, latency or subscription authentication.
