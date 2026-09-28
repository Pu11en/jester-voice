# Ticket: What happens to allwork's "Jester" trigger word at cut-over?

- `wayfinder:grilling` (HITL)
- Blocks: "Retire the old voice bot"
- Frontier: RESOLVED (2026-09-28)

## Question

`allwork` treats the spoken word "Jester" as its idea trigger. Once the bot is called Jester, every "Jester, …" would also count as an idea. A shelved local patch renames that trigger to "Goku". Activate the Goku rename at cut-over, pick another word, or turn transcript-based idea triggering off?

## Decision

Use Drew's existing Goku choice for the old allwork trigger. The separate new idea-saving feature remains canceled. The paused overnight manifest includes the local allwork change and its parser check.
