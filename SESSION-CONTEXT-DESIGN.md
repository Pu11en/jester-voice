# Jester as Drew's session reader

September 28, 2026. Drew's priority is that Jester can read what a named EBI session actually did, understand the project it is working in, and explain it naturally on request. More voice tags and lookup beyond the current 100-session snapshot are deferred. The first on-demand reader is implemented locally; real Discord voice behavior remains a separate check.

## What is failing now

Jester's `OwnerRouter` turns a named status request into a canned sentence from `state`, `currentTask`, and at most 12 recent Discord messages. It chooses the newest nonempty bot post and quotes only its first 180 characters. In the live Zoro thread, the substantive result is followed by a `Turn finished` marker and a `reply needed` notice. The current selector can mistake the notice for Zoro's answer. A natural question that misses the exact parser reaches Luna without fresh EBI evidence. Luna runs from `/tmp` and has no project context of its own.

EBI already provides read-only session metadata, up to 100 recent messages from one thread, and turn-state updates. Each message body is capped at 2,000 characters and exposes a `truncated` flag and Discord link; Jester currently drops the truncation flag. The message endpoint has no older-page cursor or attachment body. Project `AGENTS.md`, README, and current files are available locally when that project's path is verified. These are distinct evidence sources: an EBI state describes whether a worker is running; a thread answer describes what it found; project files describe the work itself.

## Options

| Approach | Benefit | Cost and failure mode | Fit now |
| --- | --- | --- | --- |
| Keep canned status rules | Fast, predictable, no model interpretation | Cannot explain actual work; bot notices and truncated quotes mislead | Insufficient |
| Fetch current evidence on each question, then let Luna explain it | Uses existing EBI and Luna; fresh, conversational, small state to maintain | One read and model turn may add latency; evidence can still be incomplete | **Recommended** |
| Maintain a background summary/index of every thread and project | Fast answers to broad history questions | New storage, update jobs, stale summaries, and recovery rules before the core read path works | Later only if measured need |
| Give a fully autonomous agent EBI and filesystem tools | Deep exploration of unusual questions | Harder to bound latency, context, authority, and accidental writes in a voice conversation | Unnecessary for the first useful version |

The recommendation follows the common retrieval pattern: fetch relevant current evidence for a question, then synthesize it. Larger indexes are useful when a corpus outgrows direct reading, but create retrieval and freshness work of their own ([Anthropic, Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)).

## Smallest useful read path

1. Drew asks, for example, “Jester, what is Zoro doing?” or “What happened with Zoro's audit?” Jester resolves one exact thread ID. An ambiguous or missing name triggers one short clarification. The same bound ID carries into follow-up questions.
2. Jester fetches fresh state and recent thread messages. It groups messages by turn, skips transport/status notices, keeps the owner's ask and substantive agent answer, and records message IDs, timestamps, links, and truncation. The turn journal can distinguish running, finished, failed, and uncertain; a `reply needed` notice means Drew may need to answer, not that Zoro's task failed.
3. For a project question, Jester reads a small, verified project context pack: project name/path, `AGENTS.md` or README, and relevant changed files or recent commit only when the question needs them. It never treats source text as a new owner instruction. If evidence is too old, clipped, missing, or contradictory, it says so.
4. Luna receives the user's question and a bounded, labeled evidence pack. It gives a short spoken answer: what the agent was asked, what it actually reported, current state, likely next decision, and what remains unknown. Factual claims map to source message IDs or file paths. An optional fuller text with links can go to Auto Transcripts.
5. Reading and explaining is read-only. A later request to send, stop, create, or change a session still goes through Jester's checked action router and its receipt path. Content found inside a thread or repo must never become an instruction to execute; tool-output prompt injection is a known agent failure mode ([OpenAI, instruction hierarchy](https://openai.com/index/instruction-hierarchy-challenge/)).

## Questions the implementation must answer

- **What counts as the answer?** Ignore typing indicators, turn markers, handoff notices, and empty bot posts. Preserve a human-authored result even if a newer status post follows it.
- **How much history is enough?** Start with the latest relevant completed turn and a small preceding window. If the answer depends on older work, add cursor-based older-page retrieval or state the limit. Do not silently treat the last 100 messages as the whole project history.
- **What does “doing” mean?** Separate current worker state from last completed result, a blocker, and an owner decision. If Jester cannot tell, say “I can see the last result, but I cannot verify what the worker is doing now.”
- **Which project evidence?** A README or AGENTS file may explain purpose; current code or artifact may prove progress. Use only a verified EBI project path, bound file sizes, and no secret files. Re-read on demand so facts do not go stale.
- **How should follow-ups work?** “What did it finish?”, “Why?”, “What should I do next?”, and “Tell me more” should use the bound thread and fetch more evidence if needed. Discussing a result is not permission to send a task.
- **What if messages are clipped or inaccessible?** Carry `truncated`, fetch more where possible, and make uncertainty audible. A failed EBI read should not become “Zoro did nothing.”
- **What if evidence conflicts?** Prefer current EBI state for run status, latest substantive answer for reported outcome, and actual project files for file facts. Distinguish a direct quote from Jester's inference.
- **How long can the answer take?** Use a short “checking Zoro” acknowledgement only if retrieval stalls. Measure this on the real path before adding caches.

## How to find missing behavior before Drew relies on it

Freeze a real, redacted Zoro thread example and replay it through the actual read path. Ask at least: “What is Zoro doing?”, “What did it finish?”, “What is this audit project?”, “Is it blocked?”, “What should I decide?”, and a natural paraphrase. Include a final answer followed by a status notice, a long/clipped answer, a failed read, a conflicting state, a changed project file, and ambiguous names. For every case, assert the sources fetched, the factual claims, the stated unknowns, and **zero EBI writes**. Record one bounded trace per turn: heard question → resolved ID → source message/file IDs → answer. End with a controlled live Discord read-only question and compare Jester's answer with the same thread and project evidence. Trace-based evaluation is the documented way to catch wrong tool choice and unsupported claims in agent workflows ([OpenAI, agent evals](https://developers.openai.com/api/docs/guides/agent-evals)).

## Decision

Build the on-demand evidence reader first. Do not add a new framework, background index, tag expansion, or paid model service for this milestone. Its first release gate is a useful, evidence-backed spoken answer about Zoro and the audit project with no write, followed by the same behavior on another session and error cases. Voice capture and action delivery remain separate readiness gates.

## First implementation and remaining limits

`SessionReader` now fetches a bounded chronological excerpt, excludes the observed status notices, carries clipped-message flags and Discord links, and reads a small local `AGENTS.md`/README context pack. `Conversation` uses this evidence for named read questions and session follow-ups through Luna; writes still use the checked router. A live **read-only** Zoro fetch confirmed that the substantive answer and project guide were present while the later handoff notice was excluded. Two direct Luna calls using that evidence produced specific, cautious status and project explanations; these did not traverse Discord audio. The offline suite uses fake EBI and Luna, so it proves routing and zero writes, not spoken accuracy in the room.

Remaining work: distinguish turn boundaries more explicitly; fetch older pages and attachment content when needed; validate status against the turn journal; include source links in a fuller text response; support broad session summaries; and test a real voice question followed by a comparison with the EBI thread. These are tracked as evidence gaps, not inferred successes.
