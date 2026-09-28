# Jester owner-only EBI control API slice

Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py
Try: uv run python -m claude_discord --help
Open: Drew's local EBI Discord threads after separate live activation

Goal: Give Jester narrow, trustworthy control of Drew's existing EBI sessions. Work only in an isolated EBI repository copy. Do not change guest permissions, run live session actions, restart the bot, call a paid model, or publish to GitHub. Keep old callers working. Each task is one checked outcome; report any interface limitation rather than claiming delivery or completion without evidence.

- [ ] Add a side-effect-free read-only session snapshot route for Jester. It must not mint tags, rename Discord threads, or modify rows, and it must return exact Discord thread IDs as strings plus current tag, name, project, and running/queued/history state. Leave the existing `/api/sessions` behavior intact. Prove repeated reads have no tag or rename writes. Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py
- [ ] Let `/api/spawn` validate and pass optional backend/model selection to `spawn_session` before the first automatic turn. Reject an unsupported combination or unavailable runtime without silently using another; reject a model without a backend. Preserve correlation-ID duplicate handling and existing default behavior. Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py
- [ ] Fix `/spoken` response language so HTTP 202 says **accepted**, never delivered or finished; return an exact string thread ID. Permit a bounded long owner prompt without truncation, using the existing Discord chunking below this endpoint. Reject input above the documented bound. Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py
- [ ] Add an owner-only idempotent `/spoken` request ID and a read-only receipt query for the exact target thread. A retry with the same ID and same payload must not post or run twice; a conflicting payload must fail. Expose accepted, posted, and failed states with a durable record so restart or an uncertain HTTP timeout can be reconciled. Do not call a task completed merely because Discord accepted a post. Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py
- [ ] Add a pure stop-current-turn endpoint for one exact EBI thread, using the existing `stop_turn` service. It must never send a new prompt, stop other threads, or archive the session; return a clear idle result when no turn is active. Check: uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py

## How to try it

1. Ask Jester what Zoro is doing; it should read real session state without changing Zoro's tag or thread name.
2. Ask Jester to send one task or create a new session; the destination thread should show one faithful instruction, and Jester should distinguish acceptance from completion.
3. Ask Jester to stop one named session; only that session's current turn should stop, and its thread should remain available.

```gowork-plan
{
  "schema_version": 1,
  "plans": [{"id": "ebi", "version": 1, "project_path": "/home/drewp/main-projects/ebi-agent-chat-relay", "check": "uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py"}],
  "requirements": [{"id": "REQ-OWNER", "outcome": "Drew can ask Jester for exact status and control one EBI session at a time without false delivery claims or duplicate work"}],
  "tasks": [
    {"id":"ebi.status","plan_id":"ebi","plan_version":1,"outcome":"Add a side-effect-free, string-ID session snapshot for Jester with tag, name, project and state; keep old /api/sessions behavior.","dependencies":[],"owned_files":["claude_discord/ext/api_server.py","tests/test_api_server.py"],"owned_resources":[],"required_inputs":["REQ-OWNER: exact read-only session state"],"output":"Read-only session snapshot route and tests","acceptance_check":"uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py","source_requirement":"REQ-OWNER"},
    {"id":"ebi.spawn","plan_id":"ebi","plan_version":1,"outcome":"Validate optional backend/model on /api/spawn and set both before the first automatic turn; preserve correlation-ID behavior and reject unsupported requests.","dependencies":["ebi.status"],"owned_files":["claude_discord/ext/api_server.py","tests/test_api_server.py"],"owned_resources":[],"required_inputs":["REQ-OWNER: requested first-turn runtime must be honored"],"output":"First-turn runtime selection and tests","acceptance_check":"uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py","source_requirement":"REQ-OWNER"},
    {"id":"ebi.acceptance","plan_id":"ebi","plan_version":1,"outcome":"Make /spoken HTTP 202 truthfully mean accepted, return string thread IDs, and support a bounded long owner prompt without truncation.","dependencies":["ebi.spawn"],"owned_files":["claude_discord/ext/api_server.py","claude_discord/spoken.py","tests/test_spoken_message.py"],"owned_resources":[],"required_inputs":["REQ-OWNER: accepted is not delivered or finished"],"output":"Truthful spoken acceptance and long-prompt tests","acceptance_check":"uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py","source_requirement":"REQ-OWNER"},
    {"id":"ebi.receipt","plan_id":"ebi","plan_version":1,"outcome":"Give owner spoken requests durable idempotent IDs and a read-only exact-thread receipt with accepted, posted and failed states; same-ID retry must never post twice.","dependencies":["ebi.acceptance"],"owned_files":["claude_discord/ext/api_server.py","claude_discord/database/","tests/test_spoken_message.py"],"owned_resources":[],"required_inputs":["REQ-OWNER: uncertain timeouts must be reconcilable without duplicate work"],"output":"Durable spoken receipts and retry tests","acceptance_check":"uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py","source_requirement":"REQ-OWNER"},
    {"id":"ebi.stop","plan_id":"ebi","plan_version":1,"outcome":"Expose an exact-thread pure stop-current-turn route through existing stop_turn; never send a prompt or archive the thread.","dependencies":["ebi.receipt"],"owned_files":["claude_discord/ext/api_server.py","tests/test_api_server.py"],"owned_resources":[],"required_inputs":["REQ-OWNER: one named active turn may be stopped without touching others"],"output":"Pure stop-turn route and tests","acceptance_check":"uv run pytest -q tests/test_api_server.py tests/test_spoken_message.py","source_requirement":"REQ-OWNER"}
  ]
}
```
