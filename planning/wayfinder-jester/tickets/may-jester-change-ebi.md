# Ticket: May the Jester build add small endpoints to EBI?

- `wayfinder:grilling` (HITL)
- Frontier: YES (can be answered any time)

## Question

Jester Control works better with a few small additions to `ebi-agent-chat-relay`:
- a read-only session list, plus a tag → thread resolve that doesn't re-deal tags;
- a push event stream for turn started/finished/failed/closed;
- "stop the current turn" without sending a prompt;
- spawn with backend/model in one call.

Is the Jester build allowed to add those (locally, tested, the owner approves the restart), or must Phase 2 use only today's API (polling `/api/sessions`, no failure signal)?
