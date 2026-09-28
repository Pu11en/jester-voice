# Wayfinder Map: Jester Voice

> `wayfinder:map` (local-markdown tracker). Tickets are child files in `wayfinder-jester/tickets/`, and research reports are in `wayfinder-jester/research/`. Charted 2026-09-27.

## Destination

**Jester is the only voice bot in the owner's Discord room.** The owner talks to it naturally for 10–15 minutes without adapting their speech (the HANDOFF feel test). It controls EBI sessions by voice, with permissions enforced in code. It keeps the room transcripts that `allwork` reads, and it surfaces meaningful EBI events. It survives crashes and restarts, and the old `drew-ai-voice-transcripts` bot is retired.

## Notes

- **Source of truth:** `HANDOFF.md`, then `REPLACES_OLD_VOICE.md`. Measured facts: `MACHINE.md`, `EBI_INTERFACES.md`, `RESEARCH.md`, `bench/*_RESULTS.md`.
- **Override (execution in the map):** this map carries execution. Build tickets point to a `PLAN-*.md` that runs unattended with `/gowork`. Decision tickets stay decisions.
- **Order rule from HANDOFF:** originally, don't build EBI control until the Phase 1 loop passes the owner's feel test. Drew subsequently requested the complete build to run unattended overnight. The automated implementation may proceed, but the owner feel test remains required before claiming the experience is accepted.
- **Owner preferences:** plain-language questions, one at a time. "Just pick one" means decide technical and taste choices by measurement. GitHub is always last.
- **Machine limits:** RTX 4060 8 GB; WSL has 4 CPU threads; C: is nearly full, so reuse `bench/.venv` and never install another large toolchain. Docker Desktop 4.92 has a WSL integration bug, worked around with `DOCKER_HOST=tcp://localhost:2375`; Jester doesn't need Docker.
- **Skills:** grilling + domain-modeling for HITL tickets, research for AFK research tickets.

## Decisions so far

- [Machine inspection](../MACHINE.md): RTX 4060 8 GB usable from WSL, 4 CPU threads, C: nearly full.
- [EBI integration surface](../EBI_INTERFACES.md): `/spoken`, `/spawn`, `/close`, `/runtime`, `/search`, and client-side tag matching exist today. No events and no failure signal.
- [Speech-to-text](../bench/STT_RESULTS.md): Parakeet v2 on the GPU, about 130 ms and 2.9% word errors; right on the owner's voice.
- [End of turn](../bench/TURN_RESULTS.md): Silero + Smart Turn v3.2 GPU at 0.5, with an adaptive fallback timeout (1.8 s, or 7 s after connector words). Only 1 of 35 of the owner's real pauses was cut.
- [Jester's voice](../bench/TTS_RESULTS.md): Kokoro GPU `af_heart`, about 280 ms to first audio, almost no CPU.
- [Brain](../bench/BRAIN_RESULTS.md): Codex app-server + Luna over the subscription. Streams, interrupts in 5 ms, first word in about 1–2 s when warm.
- [Replace the old bot](../REPLACES_OLD_VOICE.md): Jester takes over transcripts in the exact `allwork` format and reuses the EBI bot token. It auto-joins with the owner and leaves on "Jester, leave".

- [How can Jester detect EBI session finish/failure with today's API?](wayfinder-jester/tickets/ebi-event-detection-today.md): read ccdb `sessions.db` read-only every 1 s, plus `/api/sessions` every 15 s. Failure is detectable but only heuristically.
- [Phase 1 voice loop](wayfinder-jester/tickets/build-phase1-voice-loop.md): locally built and running as a user service. It hears and answers Drew, supports barge-in, and writes allwork-compatible transcript files. Its live feel bar has not passed.
- [Old voice service](wayfinder-jester/tickets/retire-old-voice-bot.md): stopped, disabled and archived on 2026-09-28; the main EBI bot stays up. The transcript channel post, privacy Pause, retention and voice EBI controls still need replacement.

## Current frontier

- [Full remaining-work plan](../PLAN-jester-completion.md): 28 small outcomes across voice/parity, safe EBI control, events and long-run behavior. The overnight manifest below assigns its 27 automated outcomes to repository-specific work copies; Drew's feel test is the remaining human outcome.
- [Overnight execution manifest](../PLAN-jester-overnight-manifest.md): 27 automated tasks across Jester, EBI and allwork in separate repository copies, with dependency checks and automatic local integration on success. It includes wake/re-arm acceptance, active-only direct tags, and a distinct transcript-only mode. One-shot scheduler tasks 31 (2026-09-28 17:00 CDT build) and 32 (2026-09-29 07:30 CDT integration check) are **disabled as of 09:30 CDT** while Drew continues planning. Both states were verified through `/api/tasks`. The build has not started yet.
- [Voice behavior gap audit](wayfinder-jester/research/voice-behavior-gap-audit.md): checks original handoff against the Phase 1 code; dormant attention and transcript-only mode were missing, and new-session work must include actually dispatching the assignment.
- [Owner feel test](wayfinder-jester/tickets/feel-test-phase1.md): open. Eight completed live turns measured about 2.8 s median to first audio, above the ~1.5 s handoff target; a 10–15 minute owner check is still required before claiming acceptance.
- [Allwork trigger decision](wayfinder-jester/tickets/allwork-trigger-at-cutover.md): resolved to Goku for the existing trigger; the new idea-saving feature remains canceled. The installed trigger still matches “Jester” until the build task runs.
- [EBI interface decision](wayfinder-jester/tickets/may-jester-change-ebi.md): resolved to narrow local, tested EBI changes for status, pure stop and guest grants, with live activation separated from the unattended build.
- **Direct-tag decision:** Drew chose tag instructions only while Jester is already engaged. Dormant tag speech remains transcript only.
- [Computer-work boundary](wayfinder-jester/tickets/computer-work-boundary.md): open. Research recommends EBI sessions perform project/computer work, while Jester uses narrow read-only EBI status/history checks. Drew has not yet chosen this boundary.
- **Next frontier:** settle the computer-work boundary, then the morning rollout state and any remaining high-impact experience boundaries before revising and resuming the schedule. The owner feel test remains the final experience gate.
- **Lean Codex profile:** stop the 8 MCP servers from loading for Jester's brain without breaking the shared login.

## Already implemented infrastructure

- The Jester user service is enabled, crash-restarts and joins the configured Discord room. The old service is archived, so no second Discord application or token is needed.
- Local STT, turn detection, TTS and Codex app-server brain are integrated; offline checks run with `bash scripts/check.sh`.
- The complete product and remaining gaps are captured in the full plan; the live feel test remains open.
- **Lean Codex profile:** stop the 8 MCP servers from loading for Jester's brain without breaking the shared login.

## Out of scope

- A pay-per-minute realtime API brain (GPT-Live), rejected on cost; and any automatic fallback chain of brains (HANDOFF).
- Building a competing long-term EBI memory system. EBI owns history; Jester queries it.
