# EBI interfaces Jester uses — 2026-09-29

This is the API surface Jester calls today, as implemented in `src/ebi-client.mjs`.
The original September 27 inspection notes are in git history (`git log -p EBI_INTERFACES.md`).

- Base URL: `http://127.0.0.1:9876` (config `ebiApiUrl`).
- Auth: when a secret is configured (`JESTER_EBI_API_SECRET`, falling back to `CCDB_API_SECRET`),
  every request carries the `Authorization` header as `Bearer <secret>` (`src/ebi-client.mjs:29`).
  Never log or print the value.
- Every thread ID is a Discord snowflake sent and read as a **string**. Jester rejects a snapshot
  with a numeric, malformed or duplicate `thread_id` rather than guess a target.
- Requests time out (default per client, 10 s for messages and search); a failed read never
  becomes a write.

## Reads

### `GET /api/jester/sessions?limit=100`

Read-only session snapshot (no tag reassignment, no renames). After the EBI change it returns
**open rows only by default**; `include_closed=1` adds closed rows. Until that change is deployed
it still returns closed rows, so Jester filters `closed: true` itself everywhere.

Top level:

| field | meaning |
| --- | --- |
| `sessions` | array of rows (below) |
| `open_count` | number of open sessions EBI knows |
| `discord_active_threads` | number of threads Discord shows as active |
| `tag_words` | size of the voice-tag word pool (ten today) |
| `generated_at` | ISO timestamp of the snapshot |

Row fields:

| field | meaning |
| --- | --- |
| `thread_id` | string snowflake; the only key Jester binds to |
| `tag` | current voice tag word, or empty when the thread holds none |
| `aliases` | recognised mishearings of the tag |
| `name` | Discord thread name |
| `project` | working folder path |
| `state` | `running`, `queued`, `recovering` or `history` (idle) |
| `current_task` | short text of the running task, may be empty |
| `closed` | `true` for a closed session (absent or false when open) |
| `visible` | whether Discord still shows the thread (null/absent on older EBI) |

Jester answers these without any model: "what's open" (list), "do you see X / is X open"
(match by tag, alias, thread name or project folder, fuzzy only on one clear best match),
"why no tag" (free and held words, who holds them), "find X" (open rows first, then
`/api/search` filtered to open thread IDs; closed-thread search is deferred), and the status
sentence for "what is X doing" when the brain is down.

### Other reads

- `GET /api/threads/{id}/messages?limit=1..100` → `{messages:[{author, is_bot, content, created_at, jump_url, truncated}]}`. Used for status and discuss answers.
- `GET /api/search?q=&origin=discord&limit=10&body=1` → `{results:[{thread_id_str, thread_name, working_dir, last_used_at, snippet, deep_link}]}`. Jester uses only `thread_id_str`.
- `GET /api/jester/turns?since=<iso>&after=<cursor>&limit=100` → `{turns:[{thread_id, turn_key, updated_at, ...}], has_more}`. Polled for finished-turn and result-watch announcements.
- `GET /api/threads/{id}/spoken/{request_id}` → durable receipt for a spoken send.
- `GET /api/correlations/{correlation_id}` → the thread a spawn created, used after a lost spawn answer.
- `POST /api/projects/resolve` `{text}` → `{kind: local_available | no_match | ..., path, name, locally_verified}`. A lookup, not a write.

## Writes (owner actions)

Actions run exactly as before: no confirmation prompt, an 800 ms settle before the side effect,
and the owner ID is always sent. Model output never enters this path.

| action | route | body |
| --- | --- | --- |
| send | `POST /api/threads/{id}/spoken` | `{text, speaker_id, mode: "queue" or "interrupt", source: "voice", request_id}` |
| create | `POST /api/spawn` | `{working_dir, user_id, backend, auto_start, correlation_id, prompt}` or `{..., empty: true, thread_name}`; optional `model` |
| stop | `POST /api/threads/{id}/stop-turn` | `{speaker_id}` |
| close | `POST /api/threads/{id}/close` | `{actor}` (the owner ID) |
| runtime | `POST /api/threads/{id}/runtime` | `{backend, model}` |

- A timed-out send is never re-posted: Jester reads the receipt for its `request_id` instead.
- A failed spawn is never repeated with a new identity: Jester reads its `correlation_id`.
- "Jester, stop" and "shut up" while a reply plays only stop Jester's voice; they never call
  `stop-turn`. Stopping an EBI session needs an explicit session stop request.

## Jester turn log (`logs/turns.jsonl`)

One JSON object per line with `at` (ISO time) and `type`. The file is private (mode 0600) and
size-bounded. It never contains secrets.

| type | when | main fields |
| --- | --- | --- |
| `turn` | a spoken reply finished | `ownerText`, `voiced_ms`, `vad_mean`, `stt_logprob` (when the worker sent them), `heardText`, `timings`, `sttMs`, `utteranceMs` |
| `barge_in` | real owner words stopped a reply | `source` (`words`, `sustained` or `turn_end`), `heard`, `bargeStopMs`, `timings` |
| `backchannel_ignored` | a hum, cough word or bare "yeah/ok" was dropped | `text`, `speaker` |
| `stop_speech` | a stop phrase cut Jester off | `text` |
| `owner_intent` | a model-free owner command matched | `kind`, `target`, `reason`, `speaker` |
| `ebi_action` | a routed EBI action ran | router trace fields |
| `brain_error` | the brain failed with a detected reason | `reason` (e.g. `usageLimitExceeded`, `unreachable`, `timeout`), `brain` (`codex` or `claude`) |
| `brainSwitched` | the fallback brain changed | `from`, `to`, `reason` (`recovered` when Codex returns) |

Backchannel-only speech is never sent to the brain, never injected into brain context and never
written to the room transcript. On a `brain_error` Jester speaks one line:
"Luna is out until October 4. I can still list, find, send, stop and close sessions."
