# Ticket: Retire the old voice bot

- `wayfinder:task` (HITL; the owner approves the restart)
- Blocked by: "Owner feel test of the Phase 1 loop", "What happens to allwork's "Jester" trigger word at cut-over?"

## Question

Follow the cut-over order in `REPLACES_OLD_VOICE.md`:
1. Confirm Jester's transcripts parse in `allwork`.
2. Stop and disable `drew-ai-voice-transcripts.service`, leaving the old files in place.
3. Enable `jester-voice.service`.
4. Verify one full voice session end to end.
