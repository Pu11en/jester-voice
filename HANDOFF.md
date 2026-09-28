# Jester Voice — Engineering Handoff

## Read this first

This file is the source of truth for the next coding session.

Jester is NOT an OpenAI GPT-Live/API project anymore. Early repo docs were created before the planning session was complete. The paid GPT-Live design was rejected because its active-session pricing is too expensive for the intended always-available experience.

Do not implement from old assumptions. Do not blindly port the existing EBI voice extension. Follow the behavior and decision hierarchy in this file, then benchmark the machine before choosing final voice components.

## Decision update — 2026-09-27

The old voice-transcripts bot will be removed entirely; Jester becomes the only voice bot. Jester therefore OWNS room transcripts (this replaces the "Existing room transcripts" section below) and must keep allwork working. Jester can reuse the existing DrewAI bot token for voice once the old service is stopped, so no separate Discord application is needed. Full inventory and cut-over order: `REPLACES_OLD_VOICE.md`.

## Decision update — 2026-09-28: attention and transcript-only mode

The owner clarified that Jester must stay conversationally dormant when it joins or after an exchange has ended. Speech in the room still goes into the agreed room transcript, but ordinary speech must not start a Luna turn or make Jester speak. Saying `Jester` starts a conversation; natural follow-ups from the engaged speaker do not need the name again. After a lull or a clear end to the exchange, Jester returns to requiring its name. Do not let ambient speech keep that engagement alive. Tune the end-of-exchange behavior against the owner feel test rather than treating a fixed timeout as the whole rule.

The owner also wants an explicit **transcript-only mode**: `Jester, just listen` means transcribe everyone in the room without spoken replies, Luna conversation calls, or EBI/session actions. Entering it stops current and queued speech and pending actions. Only the owner can switch modes; an owner phrase such as `Jester, talk again` restores normal conversational mode in its dormant state. These mode commands must be recognized without Luna, including while transcript-only mode is active. Keep the recording notice and Pause control; paused recording still captures nothing. An owner `Jester, leave` command and the typed escape hatch remain available. Show the current mode in the transcript channel without a spoken acknowledgement. The mode lasts for the current owner voice-room presence and survives a transient service reconnect during that presence; a new owner presence starts in normal dormant mode.

## Mission

Build a separate Discord voice bot/service called Jester that lets the owner operate and navigate the existing EBI/ccdb agent environment almost entirely by natural spoken conversation.

The behavioral reference is the current ChatGPT Voice experience: natural pauses, messy speech, corrections, pronouns, contextual follow-ups, concise conversational responses, streaming speech, immediate barge-in, and no requirement to speak in command syntax.

Jester adds EBI-specific control on top of that conversational experience.

## Decision hierarchy

When requirements conflict, use this order:

1. This HANDOFF.md and the explicit product decisions below.
2. Measured conversational quality on the owner's actual Lenovo.
3. Current EBI/ccdb interfaces and real runtime state.
4. Current official documentation for dependencies.
5. Existing `ebi-agent-chat-relay` voice code as OPTIONAL REFERENCE ONLY.

The old EBI voice implementation is evidence, not specification. Never inherit a behavior merely because it exists there. In particular, old fixed listening windows, 10-second silence behavior, command-oriented UX, transcript-channel UX, and other one-way-controller decisions are not Jester requirements.

## Core product behavior

### Presence

- Jester has a designated Discord voice room.
- When the owner joins, Jester should automatically join/be available without requiring `/join`.
- The owner can explicitly say something unambiguous such as `Jester, disconnect` to make Jester leave.
- Bare words like `leave`, `stop`, or `go away` must not be interpreted as disconnect commands without a clear Jester target.
- Keep a manual `/leave`-style escape hatch for failures.
- If the owner intentionally disconnects Jester, do not immediately auto-rejoin during the same owner voice presence/session.

### Conversational behavior

- Match ChatGPT Voice behavior as closely as practical instead of inventing fixed timing rules.
- No wake word on every turn.
- Saying `Jester` explicitly gets its attention.
- Once engaged with a speaker, maintain contextual engagement naturally.
- Ambient room speech is transcribed under the agreed room-transcript policy but does not start or extend conversational engagement or reach the brain as a request.
- Tentative disengagement after roughly 30 seconds of inactivity is acceptable, but this is tunable and not a hard product truth.
- When uncertain whether speech was directed at Jester, ask a very short clarification rather than confidently interrupting or acting.
- Jester speaks aloud by default when it is addressed or continuing an active exchange.
- Owner is the attention priority. Explicitly-addressed guests are second. Other room speech is ambient.
- If owner and guest speak simultaneously, prioritize the owner.

### Barge-in

- Real user speech while Jester is speaking stops Jester playback immediately.
- Cancel queued speech from the interrupted response.
- Preserve conversational state based on what was ACTUALLY PLAYED, not the full text that was generated but never heard.
- Do not trigger interruption from trivial noise/clicks/coughs if the VAD/turn system can distinguish them reliably.
- Listening/reasoning/speech may stream, but consequential tool execution should not fire halfway through an unfinished user correction such as `deploy—actually no, just run tests`.

### Shared room / permissions

Jester can converse with other people in the room. It is not owner-only as a conversational participant.

Default guest abilities:
- address Jester and have a normal conversation;
- ask general/non-sensitive questions;
- participate in an active contextual exchange;
- interrupt Jester conversationally when Jester is engaged with them.

Owner-only by default:
- disconnect/control Jester itself;
- read private EBI/session/project state;
- message/control EBI sessions;
- create/stop/change sessions;
- change folders/projects/models/backends;
- grant/revoke permissions;
- other privileged EBI actions.

Enforce permissions in deterministic code using Discord user identity. Do not rely on the LLM to remember who is authorized.

### Temporary permission delegation

The owner can grant permissions conversationally, e.g. `Jester, let Jake control Zoro until I leave`.

Requirements:
- resolve the named guest to a Discord user currently present where possible;
- scope the grant to the requested capability/session;
- grants are temporary for the current voice session by default;
- only the owner can grant, modify, revoke, or make permissions permanent;
- no re-delegation by guests;
- `Jester, take away Jake's access` revokes it;
- permanent access requires explicit owner intent, not inference.

## EBI/session model

### Tags are temporary addresses, not persistent identities

Current One Piece tags such as Zoro/Luffy/Nami are human-friendly handles for current/live sessions and can be reused over time.

For active work, the owner generally intends to address sessions by tag:
- `Tell Zoro to fix the authentication issue.`
- `Ask Nami where she's at.`

Resolve the tag through EBI/ccdb to the real unique session/thread ID. Once resolved in the live conversation, contextual references such as `him`, `that one`, or `tell him this too` should bind to the exact resolved session ID, not merely the reusable tag string.

Do not invent persistent meaning for a tag across history.

### Historical references

The owner may ask about past work without remembering the old tag. Use natural context clues (topic, approximate time, project, surrounding conversation, task) to query whatever EBI memory/history system exists at implementation time.

Resolve from real history first. Clarify only when genuinely ambiguous. Never fabricate a match.

The EBI memory system is being redesigned separately. Jester must not create a competing long-term EBI memory architecture. EBI owns session/history/project truth; Jester queries it.

### Session creation

Jester can create new EBI sessions naturally. Example:

`Jester, make a new session for the Jester Voice repo and have it investigate Discord audio receiving.`

Jester should not require command syntax or interrogate the owner about mechanics EBI can infer. EBI/ccdb owns thread/folder/tag/session creation mechanics and returns canonical identifiers/state to Jester.

### Dependencies

Do not build elaborate multi-agent competition/orchestration merely because it is possible.

Support simple dependencies when explicitly requested, e.g.:
- `When Zoro finishes, tell Sanji to start.`
- `When both are done, tell me what I can test.`

### Proactive events

Jester is proactive for meaningful EBI events.

Delivery policy:
- normal completion -> wait for a natural conversational gap;
- important/blocking/failure event -> surface at the earliest reasonable gap;
- truly urgent/time-sensitive event -> may interrupt immediately.

Do not narrate every agent update. Bundle multiple normal updates when appropriate.

When the owner is absent, do NOT keep calling the brain to monitor things. Record deterministic EBI events locally/through EBI. On return, summarize meaningful accumulated events with one brain call if necessary.

## Authority / confirmations

Bias toward autonomy. Do not require confirmation for ordinary read-only or low-impact actions.

The owner wants spoken instructions to be powerful. Avoid turning voice into a weaker interface than typed commands.

For genuinely broad/destructive/high-impact actions where intent is ambiguous (example: `stop everything`), use a short verbal clarification/confirmation. Do not add confirmation ceremonies everywhere.

Never execute an ambiguous privileged action against a guessed target.

## Brain

### Intended V1 brain

Use the owner's Codex subscription with GPT-6 Luna as the primary candidate brain.

The owner has used subscription-backed coding-agent bridges before and expects this to be workable. Do not replace this with an OpenAI pay-per-token API merely for convenience.

Implement behind a `BrainAdapter` boundary so the transport can be replaced later without rewriting Jester.

V1 has ONE brain path. No automatic fallback chain.

If Codex/Luna is rate-limited/unavailable:
- tell the owner plainly;
- wait;
- deterministic Jester controls that do not require semantic reasoning may remain available where safe;
- do not silently switch to GLM/Claude/API.

### Brain reliability

The brain interprets language; deterministic Jester Control executes and verifies actions.

System facts must come from tools/state, not model memory. Example: `What's Zoro doing?` requires a real EBI/session lookup before answering.

Keep context lean. Do not dump every Discord thread into the brain. Retrieve relevant information on demand.

Use AI freely when it adds value, but avoid wasteful background calls, polling, repeated summaries, or sending unchanged giant contexts.

## Voice stack: benchmark before locking dependencies

The final voice stack is NOT decided in this document.

Candidate directions discovered during research:

### Direction A — reusable open-source realtime voice engine

Evaluate Hugging Face `speech-to-speech` as a modular realtime VAD -> STT -> LLM -> TTS engine with streaming/realtime transport semantics. Determine whether its architecture can cleanly use:
- Discord as the outer audio transport;
- Codex/GPT-6 Luna as the brain adapter;
- Jester Control/EBI tools;
- local STT/TTS on the Lenovo.

If this materially reduces custom realtime voice engineering without harming latency/control, prefer reuse.

### Direction B — purpose-built Jester pipeline

Use a thin Jester Core around individually selected components.

Candidates to benchmark, not commitments:
- existing EBI faster-whisper setup;
- Silero VAD;
- Smart Turn v3.x semantic/prosodic end-of-turn detection;
- LiveKit-style semantic end-of-turn approaches / lightweight Node ONNX combinations;
- multiple local streaming TTS candidates (Kokoro is only one candidate);
- existing DAVE-capable Discord voice receive path as reference.

### AllGit research

The owner's `Pu11en/all-git` project contains a bundled curated repository catalog from GitHub Awesome reviews. Its bundled SQLite is at `src/allgit/catalog.sqlite3`.

On the owner's computer, BEFORE final component selection, run AllGit searches for jobs such as:
- realtime voice agent
- local voice assistant
- speech to speech
- streaming text to speech
- local speech recognition
- voice activity detection
- turn detection
- Discord voice bot
- conversational AI

Inspect strong hits and compare them against the candidates above. Do not choose a repo because it appears in AllGit; benchmark viable options.

## Existing EBI voice implementation: reference only

Inspect `Pu11en/ebi-agent-chat-relay`, especially `extensions/voice_transcripts`, AFTER understanding this handoff.

Potentially useful evidence/components already present there include:
- Discord voice receive with current DAVE-capable stack;
- per-speaker attribution;
- local faster-whisper worker;
- PCM/audio transport;
- owner identity checks;
- One Piece tag/alias behavior;
- ccdb control-plane API integration;
- `/api/threads/{id}/spoken` human-speech path;
- local persistence/job queue/restart lessons.

But do NOT inherit old UX/behavior automatically. The old implementation solves a one-way command/transcript problem and includes decisions made for reliability of that older surface.

## Existing room transcripts

EBI already has room transcription behavior. Jester should not create a second permanent room-transcript system merely because it consumes live audio.

If historical voice context is needed, use the existing EBI/transcript/history surfaces where appropriate.

## Machine / Docker strategy

The owner's Lenovo Slim 5 can struggle under heavy workloads and crashes/restarts often.

At the start of implementation, inspect before installing:
- CPU model/core count;
- RAM total/available;
- GPU model;
- VRAM;
- Docker/WSL resource limits;
- existing Node/Python/FFmpeg;
- existing STT/Whisper installs/models;
- CUDA/Vulkan/DirectML/other acceleration actually available;
- existing Codex installation/authentication;
- current EBI runtime/dependencies.

Reuse working installs where sensible. Do not duplicate heavy models unnecessarily.

Prefer local inference only for components that meet the experience bar with comfortable headroom. Do NOT run a giant local LLM for Jester; the brain is remote through the subscription.

Do not make Jester secretly throttle, pause, reprioritize, or kill EBI workers to protect voice performance. If the machine is overloaded, report degraded voice performance and change/optimize Jester components instead.

Docker is packaging, not magic. Use it where it simplifies reproducibility. A likely shape is Jester Core plus local voice services, but Codex subscription auth may remain host-side if that is the clean supported path.

## Crash recovery

Crash recovery is first-class because the owner's computer restarts/crashes frequently.

Requirements:
- auto-restart the service (Docker restart policy or an equally reliable supervisor);
- persist only Jester-specific state that cannot be reconstructed;
- on restart reconnect to Discord and query EBI/ccdb for current canonical session/tag state;
- restore queued meaningful notifications where practical;
- do not depend on LLM memory for infrastructure recovery;
- transient conversational chatter may be lost; EBI/session state must not be.

## Usage / cost philosophy

Do not optimize the experience into the ground to save tiny amounts of usage.

Principle: spend model usage when it improves the experience; eliminate invisible/dumb waste.

Avoid:
- polling Luna for deterministic status;
- AI loops while owner is absent;
- retransmitting entire histories unnecessarily;
- repeated summaries of unchanged state;
- STT/TTS compute when nobody is using Jester.

The owner should eventually be able to ask Jester conversationally about usage/health if useful, but do not build a giant usage dashboard for V1.

## Jester voice / TTS

Do not force a voice choice from abstract preference questions. Benchmark several viable local voices on the actual machine.

Select for:
- naturalness;
- time-to-first-audio;
- streaming behavior;
- clean cancellation/barge-in;
- CPU/GPU/RAM cost;
- comfort over long conversations.

Use one consistent voice for V1. Keep the TTS adapter swappable.

## Performance / quality gates

Technical success is not `the bot runs`.

Measure at minimum:
- Discord receive stability;
- STT latency and accuracy;
- end-of-turn detection latency/false cuts;
- brain first-token latency;
- TTS time-to-first-audio;
- total user-end -> Jester-first-audio latency;
- interruption stop latency;
- CPU/RAM/GPU/VRAM during idle and conversation;
- behavior under normal concurrent EBI load.

Desired conversational target: approximately <=1.5s from a clearly completed ordinary user turn to Jester beginning a response, with <=1s preferred. Do not fake speed by prematurely cutting off thinking pauses.

### Feel test

After metrics pass, the owner must talk to Jester naturally for 10-15 minutes.

FAIL if the owner has to consciously adapt speech for the bot: unnatural waiting, avoiding pauses, shortening thoughts, repeating frequently, using rigid command syntax, or hesitating to interrupt.

The experience should approximate current ChatGPT Voice behavior as closely as the modular architecture permits.

## Implementation order

### Phase 0 — inspect and research
1. Read this handoff fully.
2. Inspect machine/runtime and existing installs.
3. Inspect current EBI control interfaces and relevant voice code as reference.
4. Run AllGit searches.
5. Shortlist voice-engine/components.
6. Benchmark candidates before committing architecture.

### Phase 1 — prove the conversational loop
Build the smallest end-to-end loop:

Discord per-user audio -> VAD/turn detection -> STT -> Codex/Luna -> streaming TTS -> Discord.

Prove:
- natural turn completion;
- immediate barge-in;
- streaming response;
- speaker identity;
- owner priority;
- acceptable latency/load.

Do NOT build the entire EBI control system until this loop passes the feel/latency bar.

### Phase 2 — deterministic Jester Control
Implement typed/validated control boundaries for:
- identity/permissions;
- EBI status lookup;
- current tag -> canonical session resolution;
- message session;
- create session;
- stop/close session where supported;
- model/backend/project operations where current EBI exposes them;
- event subscription/notification queue;
- temporary permission grants.

Never let generated text become arbitrary shell commands merely because it is convenient.

### Phase 3 — contextual EBI conversation
Add:
- contextual pronoun/session references bound to canonical IDs;
- historical retrieval through EBI memory/history surfaces;
- proactive meaningful notifications;
- return-from-absence catch-up;
- simple explicitly requested dependencies.

### Phase 4 — robustness
- crash/restart recovery;
- reconnects;
- bounded audio queues/backpressure;
- resource cleanup/idle sleep;
- rate-limit/unavailable brain behavior;
- degraded-local-performance reporting
