# Ticket: Retire the old voice bot

- `wayfinder:task` (HITL)
- Status: service cut-over completed early on 2026-09-28; full feature replacement remains open
- Blocked by: "Owner feel test of the Phase 1 loop", "What happens to allwork's \"Jester\" trigger word at cut-over?" for final acceptance

## Question

Follow the cut-over order in `REPLACES_OLD_VOICE.md`:
1. Confirm Jester's transcripts parse in `allwork`.
2. Stop and disable `drew-ai-voice-transcripts.service`, leaving the old files in place.
3. Enable `jester-voice.service`.
4. Verify one full voice session end to end.

The old service was stopped, disabled and archived; Jester was enabled and answered Drew in voice. Its transcript files parse in allwork, but the Discord transcript post, privacy Pause, 30-day cleanup and spoken EBI controls have not been restored. Final acceptance follows [the completion plan](../../../PLAN-jester-completion.md).
