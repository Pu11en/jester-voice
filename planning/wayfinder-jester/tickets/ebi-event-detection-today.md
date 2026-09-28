# Ticket: How can Jester detect EBI session finish/failure with today's API?

- `wayfinder:research` (AFK)
- Frontier: YES

## Question

Using only the current `ebi-agent-chat-relay` code and API: what is the cheapest reliable way to notice that a session's turn finished, failed, got stuck, or closed, without calling the brain?
- How often is it safe to poll `/api/sessions`, given its side effects (tag reassignment, up to 12 thread renames per call)?
- Is there any file, DB row or log line that reveals a failed turn (the ❌ reaction)?
- Recommend one approach, with its cost and limits.
