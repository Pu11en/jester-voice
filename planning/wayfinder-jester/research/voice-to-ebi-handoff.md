# Voice-to-EBI handoff audit — 2026-09-28

## The intended flow

1. Drew says `Jester` to start a conversation, names an existing session or asks for a new one, and speaks naturally. A direct `Zoro, ...` instruction works while that Jester conversation is active. Ambient speech and transcript-only mode never dispatch tasks.
2. Jester waits through natural pauses and corrections, identifies the complete request and real Discord speaker, resolves a current tag to the exact EBI thread ID or a new project through the catalog, then applies deterministic action and permission checks. It does not guess an ambiguous destination.
3. For an existing thread, Jester sends one completed instruction through EBI's `/api/threads/{id}/spoken` with the actual speaker ID and `queue` by default. Explicit `stop` or `change direction now` uses an exact-thread stop/interrupt path. EBI treats a spoken owner instruction with the same authority as one typed in that session; Jester does not require a second typed confirmation for a clear request.
4. For a new thread using the default runtime, EBI's `/api/spawn` can receive the assignment as its **seed prompt** with `auto_start=true` and a correlation ID. This is one idempotent operation: creating an empty thread and then sending a second copy of the job is unnecessary. A requested backend/model must be applied before the first turn, which today's spawn API cannot do atomically.
5. Jester says which exact session accepted the work, and later reports verified progress/completion or a real blocker. A transport acceptance is not proof the agent finished.

## What option A can and cannot do

- Jester can make spoken work feel like typing by routing the task to an EBI session; that session retains normal project files, browser, shell, tools, session history, and its own permissions. Jester can ask EBI for narrow status/history facts and speak them back.
- Jester itself has no general shell, arbitrary file/browser/desktop tools, or independent project memory. It cannot truthfully claim to have inspected a screen, changed a file, or completed an EBI task until the EBI session reports evidence.
- A guest may chat normally with Jester, but today's `/spoken` endpoint rejects anyone except Drew. Guest session control requires the planned scoped EBI authorization and grants; Jester must not impersonate Drew.
- Luna or EBI may be unavailable or at capacity. Jester must say whether it accepted, queued, failed, or cannot verify a request; it must not silently switch to a paid brain.

## Concrete delivery holes found in the current interfaces

- The old voice controller gathered tagged utterances for a fixed ten-second silence period and sent nearly literal text. It could send a thought too early or route later speech to a stale target. Jester's conversational turn gate and exact-ID binding replace that behavior; do not carry over the fixed window.
- The current `/spoken` endpoint accepts at most 4,000 characters and returns HTTP 202 just after scheduling an asynchronous delivery task. Its JSON says `delivered`, but that response is only an **acceptance**, not a verified Discord post, agent start, or completion. It has no request ID for idempotent retry. Jester must not claim more than it knows; a timeout cannot trigger a blind resend. The receiving EBI function already chunks long text into Discord messages, so the 4,000-character API ceiling can be raised with a bounded limit and tests; the build also needs a receipt/status strategy and no silent truncation.
- `/api/spawn` accepts a prompt, `auto_start`, and a correlation ID, but its REST handler does not pass initial backend/model selection to the underlying `spawn_session`, which already supports both before the first run. The `/runtime` endpoint affects a later turn. Exposing validated backend/model fields at spawn is a targeted EBI change; a request such as “start a new Sonnet session to fix this” must apply Sonnet before the first task or report that the requested first-turn setup could not be honored.
- `/api/sessions` has tag-reassignment side effects and returns thread IDs as JSON numbers, which JavaScript may round. The plan already requires a read-only status endpoint and string-safe exact IDs.
- The current EBI surface has no push completion/failure feed or pure stop-turn endpoint. The plan already includes exact stop and bounded event detection; Jester must distinguish accepted, running, finished, failed, and unknown states.
- The live EBI API currently relies on local network guards if its bearer secret is unset; several privileged routes do not independently verify the real guest actor. The planned EBI changes must enforce scoped grants at the side-effecting boundary before guest work is enabled.

## Spoken task wording decided

Drew chose one clean, faithful prompt: remove filler and superseded corrections, preserve all requested details and final intent, add no new goals, and send automatically when the target is clear. A readback is available on request rather than required for every task. The room transcript keeps the recognized words; the destination thread shows the actual outbound task. Test this with self-corrections, named files/paths, a vague target, and an explicit request to read back before finalizing the overnight manifest.
