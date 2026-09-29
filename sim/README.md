# Jester offline conversation simulation

Run `node sim/run.mjs` from the Jester project. It feeds scripted owner/guest turns through the real `Conversation`, `OwnerRouter`, `Presence`, and intent parser with fake Discord, Luna, and EBI. It checks speech, silence, target IDs, exact fake EBI writes, mode changes, and no-action boundaries. The JSON evidence is in `sim/results/latest.json`; it contains no live project content or credentials. The simulator does not call a model, spend API money, start a worker, enter Discord, or post to EBI.

Each run/scenario uses isolated temporary presence and recording-privacy files,
removed when the run ends. Never use the live service's operational state as a
simulation fixture. Reports remain under `sim/results/`; human review marks are
not overwritten. The harness isolation test intercepts leave before any write,
so even a regression cannot change live presence state while the test runs.

Open `http://localhost:8798/`. The `jester-review.service` user service keeps this localhost page available across chat sessions and restarts; its source unit is `deploy/jester-review.service`. Check it with `systemctl --user status jester-review.service`. The page copies the case-by-case human review pattern from Drew's Eval: it shows what Jester heard, said, and sent, plus an automatic grade. Drew can mark **Looks right**, **Needs change**, or **Unsure** and add a note. Marks persist in `sim/results/review.json` through page reloads and simulation reruns. Read and incorporate that feedback before any live Discord test.

## Scenario format

The scenarios are in `sim/scenarios.mjs`; `validateScenario` in `sim/run.mjs` checks their shape and `node --test sim/run.test.mjs` runs it on every scenario.

- A step is `{ speaker: "owner" | "guest", text, expect }` and plays as one worker `turn_end`.
- A step may instead script `events`: an ordered list of `speech_start`, `speech_sustained`, `pause` and `turn_end`. Each gets the A7 worker fields (`voiced_ms`, `vad_mean`, `stt_logprob`, `prob`) unless the step overrides them. Events are 30 ms apart; checks run 950 ms after the last one.
- `holdPlayback: true` on a scenario keeps every reply "playing" (no `say_done`) until a step sets `release: true`, so owner noises arrive mid-answer.
- `brainFailure: "<reason>"` makes every Luna request reject before the first word with `Error.reason`, the same shape as `FallbackBrain` when both brains fail.
- `rows` replaces the fake EBI snapshot (string thread IDs; `closed: true` rows stay in the snapshot, as EBI returns them today).
- `expect` keys: `says`, `saysNot`, `silence`, `writes` (spoken, spawn, stop and close all count), `writeKind`, `writeTarget`, `writeThreadId`, `writeText`, `writeExcludes`, `brain` (requests), `brainAnswers` (requests that produced words), `stops` (playback stops in the step), `stopOn` (the event whose handler must stop playback synchronously), `transcriptOmits` (room transcript lines), `watches`, `groups`, `muted`, `disconnected`.

The three voice-behaviour cases are `hum-during-answer`, `stop-mid-answer` and `luna-down-reads`.

Add a real trial phrase there before fixing its behavior. Passing text simulation does not prove speech recognition, audio latency, Discord muting, a real EBI receipt, or natural phrasing outside these scripts. Those need separate offline audio checks and then a supervised disposable live session.

This follows the same scripted multi-turn, mock-tool approach documented by [LiveKit Agents](https://docs.livekit.io/testing/unit-tests/) and [Pipecat Evals](https://docs.pipecat.ai/pipecat/evals/scripted-scenarios). Their built-in runners assume their own agent transports; this small adapter runs Jester's existing Discord/Node controller directly.
