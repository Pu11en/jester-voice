# EBI turn/session event detection without an LLM (2026-09-27)

## Which code is live
PID 1893 runs from `ebi-agent-chat-relay/.venv`. The venv's `_ccdb_dev_hook.pth` redirects imports to the folder named in `~/.ccdb-dev-worktree`. That folder is `/home/drewp/.local/state/ccdb/session-wt/fix-dsh-stop-continuity-20260927`, which is main 53fa8a7 plus a DeepSeek stop fix. The bot log's tracebacks confirm this path. **`wt-task-loop` is NOT live:** it is 2026-09-21 code with no voice tags and no capacity journal. For everything below, the main folder matches live (`api_server.py`, `voice_tags.py` and `capacity_recovery.py` are identical). `L=` below is the live worktree.

## 1. Polling `GET /api/sessions`
- Tagging runs on every call: `L/claude_discord/ext/api_server.py:2120` calls `VoiceTagger.apply` (`voice_tags.py:97`). No query param turns it off; the `state` filter is applied after tagging (`api_server.py:2136`).
- **Renames are skipped when the title already matches.** The check is `title_tag(name) == label` (`voice_tags.py:153`), and closed sessions are skipped too (`:158`). Each call handles at most 12 threads (`:49`, `:149`). In steady state a poll therefore makes zero Discord calls; a measured call took 8 ms and returned 28 KB.
- Hazards:
  - The budget counter runs before the archived check (`:160-163`). An open-but-archived thread with a stale title costs one `fetch_channel` REST call on every poll, forever.
  - Discord allows about 2 channel renames per 10 minutes per thread. discord.py 2.7.1 defaults to `max_ratelimit_timeout=None`, which means it **sleeps on a 429** (`.venv/.../discord/http.py:739-754`). Renames are awaited inside the request, so one 429 could stall a `/api/sessions` response for minutes. Jester needs a 2-3 s client timeout and at most one request in flight.
  - The logs show no PATCH 429s so far. The 429s seen (138 of them) are thread-member PUTs, unrelated to polling.
  - Tags are assigned over the visible set, which depends on `limit` (`voice_labels.py:142-167`). Words are only reclaimed when all 10 are in use. Today's callers: the voice extension uses `limit=50` about every 65 s, agents use the default 20, and some calls use `state=running`. **Jester should use `limit=50`** so its visible set matches the voice extension's.
  - Each call writes one aiohttp access-log line. The log rotates at 10 MB with only one backup, so polling every 1 s would spend about 13 MB a day of log space.
- **No read-only HTTP alternative reports running state.** `/api/lounge`, `/api/threads/{id}/runtime`, `/metadata` and `/api/search` have no side effects, but none of them show turn state. The only side-effect-free option is reading the database directly (section 3).

## 2. Durable signals
**Database:** `/home/drewp/main-projects/ebi-agent-chat-relay/data/sessions.db`. `tasks.db` (last written Sep 15) and `notifications.db` are irrelevant.
- **`capacity_pending_turns`** is a per-turn journal. Every Discord turn goes through it, since `capacity_recovery=True` is the default (`cogs/run_config.py:151`, `_run_helper.py:621-626`). Columns: `turn_key` (`discord:<thread>:<uuid>`), `thread_id`, `backend`, `model`, `state` (pending|scheduled|running|accepted|expired), `attempt`, `next_attempt_at`, `claimed_at`, `accepted_at`, `expires_at`, `created_at`, `updated_at`. Timestamps are UTC ISO.
  - A row is created and set to `running` at turn start (`capacity_recovery.py:319-336`).
  - `accepted` plus `accepted_at` means the turn ended without a classified failure (`:353`). An empty answer also counts as accepted (`:164-173`).
  - **A failed turn is parked:** `state='scheduled' AND next_attempt_at = expires_at` (`_park`, `:407-416`). The failure category is only in the log.
  - `expired` means the restart loader dropped a stale pending turn (`:429`).
  - **Caveat 1:** user interrupts are also classified `permanent_error` and parked. Seen on thread 1553899450227757156 six times between 18:46 and 19:08, each followed about 1 s later by a new row. Rule: a parked row with a newer row on the same thread within about 5 s is "interrupted"; otherwise it is "failed".
  - **Caveat 2:** orphan `running` rows exist. Thread 1553920599368147115 has been `running` since 00:05Z but closed at 21:15. Rows are only expired at startup. Never treat a `running` row alone as live.
- **`sessions`** holds `lifecycle_state` (open|closing|closed), `close_requested_at`, `closed_at`, `close_authority`, `wrap_up` and `last_used_at`. Its timestamps are localtime strings. **This is the durable "closed" signal.**
- **`settings`** holds `voice_label:<thread_id>`, i.e. the tags, readable without side effects.
- The **❌ reaction is not durable, even in Discord.** `set_error` holds it for 2.5 s and then `cleanup()` removes all reactions (`discord_ui/status.py:118-124`). The stall reactions ⏳ (10/30 s) and ⚠️ (30/120 s) (`status.py:27-50`) exist only in Discord.
- **Log:** `/home/drewp/.local/state/ebi-agent-chat-relay/discord-bot.log` (`CCDB_LOG_FILE`) has two useful lines:
  - `capacity recovery turn=... thread=... {'phase','category',...}` (`capacity_recovery.py:268`)
  - `Error running Claude CLI for thread N` (`_run_helper.py:716`)
  These are useful for the reason but fragile to parse, and rotation loses them.
- **Stuck:** `/api/sessions` has no turn start time. Use the running row's `claimed_at`, confirmed by `/api/sessions` `state=running`. `capacity.recovery[]` gives `since` for provider-retry waits (`api_server.py:2127-2135`).

## 3. Reading the database directly
- It is in WAL mode (`database/models.py:412`). The bot opens a short-lived connection per call with a 30 s busy timeout (`claude_code_core/session_repo.py:110,121`); no `-wal` file stays on disk between writes.
- WAL readers never block writers. The only real risk is holding a read transaction open, which stops the WAL from being checkpointed or deleted.
- Rules for Jester:
  - Open with `file:...sessions.db?mode=ro`, never `immutable=1`.
  - Set `busy_timeout=1000`, run one short SELECT per tick, then close.
  - Never write or run PRAGMAs that change anything.
  - Fail soft if the schema changes; it is internal, not an API.
- Queries (both use indexes):
  - `SELECT turn_key,thread_id,state,next_attempt_at=expires_at AS parked,created_at,claimed_at,accepted_at,updated_at FROM capacity_pending_turns WHERE updated_at > :cursor ORDER BY updated_at`
  - `SELECT thread_id,lifecycle_state,closed_at FROM sessions WHERE last_used_at > :since OR closed_at > :since`

## 4. Recommendation (today's code, no EBI changes)
**Use the database as the event source and the API to reconcile.**
- Every **1 s**, read `sessions.db` read-only with the cursor query above.
  - New row → turn started.
  - `accepted` → turn finished OK.
  - Parked row with no follow-up within 5 s → turn FAILED. Parked with a follow-up → interrupted (stay silent).
  - `lifecycle_state` becomes `closed` → session closed.
  - Cost is well under 1 ms per tick, with no Discord calls, no log lines and no tag effects.
- Every **15 s**, call `GET /api/sessions?limit=50` with a 3 s timeout and one request in flight. This refreshes tags and aliases and gives the real `running` set. It adds about 5,800 log lines a day, and Jester's calls leave titles unchanged in steady state.
  - A thread running in the database but absent from the API → orphan; ignore it.
  - A thread running in both for more than 10 minutes (configurable) since `claimed_at` → **stuck**. Announce it once, then again at 30 minutes.
  - `state=recovering` → "waiting for model capacity".
- Limits:
  - There is no error reason unless Jester tails the log.
  - Ending by user interrupt versus Stop button versus real error is heuristic.
  - Turns with `capacity_recovery=False` (none found in the Discord paths) would be invisible to the database.
  - Worst-case latency is about 1 s for end and close, and 15 s to confirm stuck.

## Minimal EBI additions (if the owner allows)
1. Add `GET /api/sessions?tags=0` that skips `_apply_voice_labels`, plus a read-only `GET /api/voice-tags`.
2. Add `outcome` (`ok|error|interrupted|stopped`) and `error_category` columns to `capacity_pending_turns`, set in `_accept` and `_park`. Classify SIGINT/stop as `interrupted`, not `permanent_error`.
3. Add `turn_started_at` to `ActiveSession` (`concurrency.py:22`) and expose it in `/api/sessions`.
4. Expire orphan `running` rows on unregister or periodically, not just at startup.
5. Optional push feed: `GET /api/events` (SSE), fed from `_emit_result_sink` (`_run_helper.py:940`), turn start, and close.
6. Bound retitles: skip on 429 (a short `max_ratelimit_timeout`, or run it in the background), and count the budget only on real edits.
