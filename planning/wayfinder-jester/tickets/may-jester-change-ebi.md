# Ticket: May the Jester build add small endpoints to EBI?

- `wayfinder:grilling` (HITL)
- Frontier: RESOLVED (2026-09-28)

## Question

Jester Control works better with a few small additions to `ebi-agent-chat-relay`:
- a read-only session list, plus a tag → thread resolve that doesn't re-deal tags;
- a push event stream for turn started/finished/failed/closed;
- "stop the current turn" without sending a prompt;
- spawn with backend/model in one call.

Is the Jester build allowed to add those (locally, tested, the owner approves the restart), or must Phase 2 use only today's API (polling `/api/sessions`, no failure signal)?

## Decision

The overnight manifest includes the narrow local EBI changes needed for read-only status, pure stop, and scoped guest authorization. Changes are built and tested in an EBI work copy. Live activation remains a separate supervised step after integration and active-session checks. Do not build a broad new event architecture solely for Jester; use the researched read-only event journal unless the local EBI changes make a better small event surface available.
