# Ticket: Owner feel test of the Phase 1 loop

- `wayfinder:task` (HITL)
- Status: open; Phase 1 is running, but the owner quality gate has not passed
- Frontier: YES, after the first voice-quality fixes in the completion plan
- Blocks: "Retire the old voice bot"; the Phase 2 plan (in fog)

## Question

The owner talks to Jester naturally for 10–15 minutes. Pass or fail, per the HANDOFF bar: no cut-offs mid-thought, replies in about 2 s or less, immediate barge-in, and no adapting speech. Record the failures and the numbers from `logs/turns.jsonl`. Every failure becomes a fix task before Phase 2 starts.

Eight completed live turns measured about 2.8 s median from end of speech to first audio, with one 10.2 s stall. The conversation layer waits for the whole brain reply before speaking the first sentence; that and the premature stall cue are first fixes in [the completion plan](../../../PLAN-jester-completion.md). Drew's 10–15 minute quality judgment is still required.
