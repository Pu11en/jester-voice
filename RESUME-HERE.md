# Jester: resume here

Saved September 28, 2026, 19:35 CDT. Full progress record: `sim/STATUS.md`. Product rules: `HANDOFF.md`.

## What is live

- `jester-voice.service` runs the new owner-command code since 18:33. Speech models loaded cleanly.
- `ebi-agent-chat-relay.service` was reloaded at 19:08 with spawn tag fix `48f67d5`.
- `zoro` maps to the original Drews Audit thread `1553779983158349925`.
- `jester-review.service` serves the simulation review page on port 8798.

## What is proven

- 133 Node tests, 7 Python tests, 16 of 16 conversation simulations.
- 20-minute speech soak: 174 nonempty turns, 28 voice replies, zero errors.
- One disposable live run: empty session created, one spoken task posted with a receipt, reply seen, thread closed, Zoro tag untouched. Evidence is in `sim/results/live-owner-check.json`.

## What is not proven

- A real Discord microphone round trip. Drew has to speak in the room.
- Code changed after the 16:36 code review has had no review: Jester `5653e5e`, `e53aa95`, `5f16221`, and EBI `726ecaf`, `48f67d5`.

## Open problem: voice tags are all taken

All ten tags are held. Only `zoro` and `nami` are sessions Drew uses. Eight are held by finished task loop workers from the EBI relay build. EBI lists 17 sessions open while Discord had 8 active threads.

Cause: `claude_discord/cogs/task_loop.py` in the EBI repo archives a finished worker thread in Discord but never marks its session closed. Tags are released only for closed sessions. Effect: a session created by voice gets no tag and cannot be addressed by name.

Nothing has been changed for this yet. Proposed fix, in order:

1. Mark the worker session closed when the task loop archives its thread.
2. Never give a voice tag to a task loop worker or reviewer.
3. One-time cleanup: close the stale worker sessions to free eight tags.

## Cautions

- Every EBI restart wakes the task loops and runs a paid Codex turn. It happened at 17:59 and at 19:08.
- `jq` is not installed. The rollout notifier failed on it. Use Python for JSON in scripts.
- Neither repo is pushed. Jester `main` is 87 commits ahead of GitHub. EBI `main` is 2 ahead.
- Check the lounge and live sessions before any EBI restart.

## Next steps

1. Drew does the real room trial using `LIVE-CHECK-jester-owner.md` and reports misses.
2. Fix the voice tag problem in EBI, then reload during an idle window.
3. Review the five unreviewed commits.

## Prompt for the next session

Read `RESUME-HERE.md` and the last four paragraphs of `sim/STATUS.md` in `/home/drewp/main-projects/jester-voice`. Confirm both services are healthy, then start on the next step Drew picks.
