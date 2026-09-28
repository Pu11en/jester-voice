# Ticket: How can Jester detect EBI session finish/failure with today's API?

- `wayfinder:research` (AFK)
- Frontier: YES

## Question

Using only the current `ebi-agent-chat-relay` code and API: what is the cheapest reliable way to notice that a session's turn finished, failed, got stuck, or closed, without calling the brain?
- How often is it safe to poll `/api/sessions`, given its side effects (tag reassignment, up to 12 thread renames per call)?
- Is there any file, DB row or log line that reveals a failed turn (the ❌ reaction)?
- Recommend one approach, with its cost and limits.

---

## ✅ RESOLVED 2026-09-27 (wayfinder:research, closed)

Read the ccdb SQLite **read-only** (`data/sessions.db`, WAL, `mode=ro`, `busy_timeout=1000`, one short query per tick) every 1 s:
- `capacity_pending_turns` tells turn start, finish (`accepted`) and failure/interrupt (`scheduled` with `next_attempt_at = expires_at`; a new row within about 5 s means an interrupt).
- `sessions.lifecycle_state`/`closed_at` tells a session closed.

Poll `GET /api/sessions?limit=50` every 15 s (3 s timeout) for tags and the true running set. Stuck means running over 10 min, and again at 30 min.

Limits: no error reason, interrupt vs failure is a heuristic, and the schema is internal, so fail soft. The ❌ reaction isn't durable (it's removed after 2.5 s).

The live bot runs from `~/.local/state/ccdb/session-wt/fix-dsh-stop-continuity-20260927` (dev hook), not `wt-task-loop`.

Full report: research/ebi-event-detection.md
