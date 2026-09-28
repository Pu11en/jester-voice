# Wayfinder Map: Jester Voice

> `wayfinder:map` (local-markdown tracker). Tickets are child files in `wayfinder-jester/tickets/`, and research reports are in `wayfinder-jester/research/`. Charted 2026-09-27.

## Destination

**Jester is the only voice bot in the owner's Discord room.** The owner talks to it naturally for 10–15 minutes without adapting their speech (the HANDOFF feel test). It controls EBI sessions by voice, with permissions enforced in code. It keeps the room transcripts that `allwork` reads, and it surfaces meaningful EBI events. It survives crashes and restarts, and the old `drew-ai-voice-transcripts` bot is retired.

## Notes

- **Source of truth:** `HANDOFF.md`, then `REPLACES_OLD_VOICE.md`. Measured facts: `MACHINE.md`, `EBI_INTERFACES.md`, `RESEARCH.md`, `bench/*_RESULTS.md`.
- **Override (execution in the map):** this map carries execution. Build tickets point to a `PLAN-*.md` that runs unattended with `/gowork`. Decision tickets stay decisions.
- **Order rule from HANDOFF:** don't build EBI control until the Phase 1 loop passes the owner's feel test.
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

## Not yet specified

- **Phase 2, Jester Control plan:** the typed actions (status, message by tag, spawn, close, model/backend switch, history search) and the permission/grant store. Waits on the feel test, the EBI-changes decision and the event research.
- **Guests:** conversation rules, temporary grants and whether grants survive a crash.
- **Proactive events:** how updates are worded, when to speak up versus wait for a gap, and catch-up after the owner has been away.
- **Crash recovery and deploy:** systemd user unit vs Docker, what state to persist, reconnects, idle sleep.
- **Lean Codex profile:** stop the 8 MCP servers from loading for Jester's brain without breaking the shared login.

## Out of scope

- A pay-per-minute realtime API brain (GPT-Live), rejected on cost; and any automatic fallback chain of brains (HANDOFF).
- Building a competing long-term EBI memory system. EBI owns history; Jester queries it.
