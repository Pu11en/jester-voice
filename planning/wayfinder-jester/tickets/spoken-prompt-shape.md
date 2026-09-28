# Ticket: What should Jester send to an EBI session after a voice conversation?

- `wayfinder:grilling` (HITL)
- Frontier: RESOLVED (2026-09-28)
- Research: [voice-to-EBI handoff audit](../research/voice-to-ebi-handoff.md)

## Question

The old voice bot forwarded recognized words nearly as spoken after a ten-second silence window. Drew wants talking to Jester to feel like typing a prompt, with Jester helping to interpret messy speech and corrections. The handoff says to use Luna for language and deterministic code for actions, but does not say how much Jester may rewrite the task sent to Zoro/Nami. This choice affects fidelity, latency, and how often Jester asks before sending.

## Recommendation

Send one clean, faithful prompt after Drew finishes the thought: remove filler and superseded corrections, preserve concrete names/paths/constraints, add no goals Drew did not request, and send automatically when target and intent are clear. Save the exact recognized words in the room transcript. Clarify only a genuinely uncertain target or high-impact ambiguity. The owner can ask Jester to read back or revise a draft when desired.

## Decision

Drew chose A because he wants the simpler behavior with less room for error. Use the recommended clean, faithful prompt, sent automatically when clear. Do not add a routine readback or confirmation step.
