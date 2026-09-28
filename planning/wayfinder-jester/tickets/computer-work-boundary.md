# Ticket: Who actually performs computer work requested by voice?

- `wayfinder:grilling` (HITL)
- Frontier: YES (2026-09-28)
- Research: [computer-access boundary](../research/computer-access-boundary.md)

## Question

When Drew asks Jester to inspect a project, change files, browse, or run a task, should Jester itself use computer tools, or should it send the request to an EBI session and report back? The existing handoff rules out arbitrary model-authored shell commands but does not explicitly settle all direct read-only or app actions.

## Recommendation

Use EBI sessions for file, app, browser, and shell work; let Jester make narrow read-only EBI status/history checks itself. This gives Drew hands-free control of complete work sessions while keeping their execution and recovery in the existing agent system. The alternative boundaries and evidence are in the research note. No overnight build task has started.
