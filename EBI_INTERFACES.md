# EBI Integration Surface — 2026-09-27

Read-only inspection (START_HERE step 3). Relay: `~/main-projects/ebi-agent-chat-relay` @ 53fa8a7. Paths below are relative to `claude_discord/` unless noted. Routes are registered in `ext/api_server.py:482-553`.

## Control API (`http://127.0.0.1:9876`)

### Sessions
- `GET /api/sessions?limit=100&state=running|queued|history` → `{sessions, capacity}`. Session fields: `thread_id, session_id, thread_name, working_dir, backend, model, origin, summary, created_at, last_used_at, closed, current_task, state, voice_label, voice_label_aliases[], latest_lounge`.
  - ⚠️ **Not read-only**: each call assigns/reclaims tags and renames up to 12 threads (`voice_labels.py:118`, `voice_tags.py:96`).
  - Only scans the top `limit` rows plus live sessions → always use `limit=100`.
- `GET /api/threads/{id}/messages?limit≤100` → recent Discord messages (no reactions).
- `GET|POST /api/threads/{id}/runtime` `{backend?, model?}` → applies on the next turn. Backends: `claude|codex|local|dsh|agui`.
- `GET /api/threads/{id}/metadata`, `GET /api/correlations/{cid}`.

### Talking to a session
- **`POST /api/threads/{id}/spoken`** `{text≤4000, speaker_id, source:"voice", mode:"queue"|"interrupt"}` → 202. This is Jester's path. `speaker_id` must equal `DISCORD_OWNER_ID`, else 403 (`api_server.py:1396`). `interrupt` sends SIGINT to the running turn.
- `POST /api/threads/{id}/message` is agent-to-agent (relay marker, 60s cooldown, 2 hops) — **wrong path for Jester**.

### Create / close
- `POST /api/spawn` `{prompt*, thread_name?, working_dir?, user_id?, auto_start, parent_thread_id?, correlation_id?}` → 201 `{thread_id(str), thread_name, voice_label, ...}`. A repeated `correlation_id` → 200 `existing` (idempotent, useful after a crash). No backend/model field: set it afterwards via `/runtime`.
- `POST /api/threads/{id}/close` `{actor*}` → `closed|pending|already_closed|not_requested`.
- The folder can only be set at spawn. There is no "stop the current turn" endpoint; the workaround is `/spoken` with `mode:"interrupt"`.

### Search / history
- `GET /api/search?q=&limit≤50&body=1` → `{results:[{thread_id, session_id, thread_name, summary, working_dir, last_used_at, snippet, deep_link}]}`. This is the historical-lookup surface. There is no separate memory endpoint.
- Also: lounge, claims, `projects` + `projects/resolve`, `project-lookup`, `notify`, `loops`, `tasks`.

## IDs
- The canonical ID is the **Discord thread snowflake**. `session_id` is the backend UUID: null until the first turn, and it changes on resume or a backend switch → never key on it.
- ⚠️ `/api/sessions` returns `thread_id` as a JSON **number** (JS precision loss); spawn returns a string. The existing voice client quotes IDs before parsing (`extensions/voice_transcripts/src/control/api.mjs:28`) — Jester must do the same.

## One Piece tags
- Pool of 10: luffy, zoro, nami, sanji, chopper, franky, jinbe, usopp, shanks, mihawk (`voice_labels.py:47`). Mishearing aliases are in `LABEL_ALIASES` (`:69`) and are exposed as `voice_label_aliases`.
- Stored as setting `voice_label:<thread_id>`. Assigned on thread creation, on spawn, and in bulk on every `/api/sessions` call. Reclaimed when a session closes or when the pool is full (oldest unlisted thread loses its tag first). Moves with a continued conversation.
- **No resolve endpoint.** Match `voice_label`/`voice_label_aliases` from `/api/sessions` client-side, then bind the conversation to `thread_id` (matches HANDOFF: tags are temporary addresses).

## Events
- **No push mechanism** (no SSE, websocket or outbound webhook).
- Cheapest deterministic detection: poll `GET /api/sessions?limit=100` (no brain calls). `state` running/queued/recovering → `history` = turn finished; `closed:true` = session ended.
- **Failure is not exposed anywhere** (the ❌ reaction isn't in the API).
- Polling has side effects (tag reassignment and thread renames), so keep the interval modest.

## Auth / permissions
- Bearer auth is only enforced if `CCDB_API_SECRET` is set; the **live `.env` doesn't set it**. The API is protected by a loopback/Host/Origin guard only (`api_server.py:582`).
- Only `/spoken` checks owner identity. `/close` accepts any `actor` string. **Jester Control must enforce all permissions itself.**

## Existing voice extension (reference only)
Deployed from `~/main-projects/drew-ai-voice-runtime/extensions/voice_transcripts` (branch `deploy/drew-ai-voice-transcripts`, with uncommitted changes; its README is stale).

### Stack
- `@discordjs/voice` 0.19.2, `discord.js` 14.27.0, `@discordjs/opus` 0.10.0, `prism-media` 1.3.5, DAVE via `@snazzah/davey` 0.1.12. Node ≥22.12.
- Join: `selfDeaf:false, selfMute:true`, with DAVE debug logging (decrypt failures drop packets silently).
- Receive: per-user `receiver.subscribe(userId, AfterSilence)`, Opus → 48 kHz stereo s16 PCM.
- Receive-only: **no playback / AudioPlayer anywhere**.

### STT
- WAV files on disk, then a SQLite job queue, then a persistent Python faster-whisper worker (JSON lines over stdin/stdout).
- Runs on the CPU (int8, `small.en`), in batch not streaming, one job at a time; comments note up to 30s lag.
- Confidence floors: drop segments with `no_speech_prob>0.6` or `avg_logprob<-1.0`.

### Control
- Uses `api.mjs`: sessions, projects, spawn, runtime, close, spoken.
- Exact tag and alias matching (tag within the first 6 words, not preceded by an article or naming verb).
- 4s end-of-speech wait plus 10s silence before sending.

### ⚠️ Bot identity
It uses **EBI's own bot token** (`DISCORD_BOT_TOKEN` from the relay `.env`). One bot can only hold one voice connection per server, so **Jester needs its own Discord application/token** to share the room with the transcript bot.

### Worth reusing
- Join/subscribe/decode code and DAVE logging.
- Filtering out bots and Jester's own audio.
- ID-safe API client.
- Tag/alias matching rules.
- Whisper confidence floors.
- Allowlisted worker environment, `flock`, and never deploying from `session/*` worktrees.

### Lessons
- Whisper outputs "Thank you." on near-silence.
- VAD erased short wake-word clips.
- Prompting Whisper with the tag list made it invent tags.
- Measure timing from when speech ended, not from when the text arrived.
- The owner's pauses between utterances: median 3.2s, 80% under 12.7s (8,501 samples). Turn detection must tolerate long thinking pauses.

### Don't inherit
- Muted, receive-only bot.
- 4s + 10s waits.
- Disk/SQLite batch STT.
- CPU-only Whisper.
- Text replies in the transcript channel.
- Silently ignoring input without a tag.

## Gaps Jester will hit (possible small EBI additions later)
1. Read-only session list and a tag → thread resolve endpoint.
2. Push events for turn start, end, error and close.
3. Per-thread last-turn outcome (ok/error).
4. Stop the current turn without sending a prompt.
5. Spawn with backend/model in one call; change the folder after spawn.
6. Thread IDs always returned as strings.
