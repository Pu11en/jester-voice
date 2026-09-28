# Jester overnight full implementation

Check: bash scripts/check.sh
Try: systemctl --user start jester-voice.service
Open: Drew's configured Discord voice room

Goal: Build the complete Jester Voice implementation across the Jester, EBI and allwork repositories in isolated copies, with exact cross-repository dependencies and automatic local integration only after each repository's offline checks pass. `HANDOFF.md`, `REPLACES_OLD_VOICE.md`, and `PLAN-jester-completion.md` are the source of truth. Use Codex first and Claude only if Codex reaches its usage limit. Do not use paid API fallback, push to GitHub, or run live voice/model tests as an automated check.

Done when: Every manifest task is accepted; each repository's offline check passes in the integrated local tree; privacy, identity and action behavior are covered by tests; and the final report clearly separates automated completion from Drew's still-required live 10–15 minute feel test.

## Decisions used for the overnight build

- Make the small local EBI endpoints needed for side-effect-free status, pure stop and scoped guest actions.
- Use Drew's earlier Goku choice for the existing allwork trigger; keep canceled new idea saving shelved.
- Build EBI control after the automated voice repairs, as requested for overnight completion. The human feel judgment remains tomorrow and can produce new fix tasks.
- If an endpoint, grant or transcript/privacy behavior is ambiguous, choose the narrowest deterministic behavior consistent with `HANDOFF.md`, record it in `DECISIONS-LOG.md`, and continue.
- Do not stop for a taste or implementation question during the run. If a real missing credential, unsafe merge or unavailable provider blocks one task, report that precise blocker and continue any independent ready work.
- No worker may restart the live EBI/Jester services, modify a live session, call Luna or Discord in tests, or publish to GitHub. The final live activation is a separate supervised step after local integration and active-session checks.

## Agreed outcomes

- Natural streaming voice, wake-on-name conversation, transcript-only mode and guest conversation.
- Replaced transcript channel, recording privacy and retention behavior.
- Exact EBI session control with real speaker identity and scoped grants.
- Contextual history, meaningful event updates, simple dependencies and restart recovery.
- Existing allwork workflow uses Goku so ordinary Jester commands do not trigger it.

```gowork-plan
{
  "schema_version": 1,
  "plans": [
    {
      "id": "jester",
      "version": 1,
      "project_path": ".",
      "check": "bash scripts/check.sh"
    },
    {
      "id": "ebi",
      "version": 1,
      "parent_id": "jester",
      "project_path": "/home/drewp/main-projects/ebi-agent-chat-relay",
      "check": "uv run pytest -q tests/test_api_server.py tests/test_jester_voice_bridge.py"
    },
    {
      "id": "allwork",
      "version": 1,
      "parent_id": "jester",
      "project_path": "/home/drewp/main-projects/automate 247/allwork",
      "check": "python3 -m pytest -q tests/test_ideas.py tests/test_transcript.py"
    }
  ],
  "requirements": [
    {
      "id": "REQ-VOICE",
      "outcome": "Natural, prompt speech and safe guest conversation"
    },
    {
      "id": "REQ-PRIVACY",
      "outcome": "Transcript channel, privacy pause and 30-day retention match the replaced service"
    },
    {
      "id": "REQ-CONTROL",
      "outcome": "Exact-ID EBI control with deterministic owner and guest permissions"
    },
    {
      "id": "REQ-EVENTS",
      "outcome": "History, meaningful events, dependencies and recovery survive long sessions"
    },
    {
      "id": "REQ-ALLWORK",
      "outcome": "Jester bot speech does not trigger the separate allwork workflow"
    }
  ],
  "tasks": [
    {
      "id": "jester.01",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Stream speech after Drew finishes a turn.. Keep speculative output silent until turn end, then send each completed Luna sentence to Kokoro as it arrives; cancel a stale sentence on correction or interruption. A fake slow brain must prove the first sentence plays before the final sentence exists. Repo: Jester.",
      "dependencies": [],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Stream speech after Drew finishes a turn. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.02",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Keep the stall cue out of Drew's pauses.. Play the cached cue only after an accepted turn has waited 2.5 seconds for a word; never play it during a tentative pause, after barge-in, or twice for one turn. Repo: Jester.",
      "dependencies": [
        "jester.01"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Keep the stall cue out of Drew's pauses. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.03",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Handle an unavailable brain aloud.. If Codex login, quota, or app-server fails, tell Drew briefly with a local cached voice clip and keep deterministic leave/privacy controls available; do not silently switch to a paid API or another model. Repo: Jester.",
      "dependencies": [
        "jester.02"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Handle an unavailable brain aloud. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.04",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add conversational attention. On join and after an exchange ends, require an addressed Jester before Luna or speech; a session tag alone does not wake Jester. Allow natural follow-ups during an active exchange, then re-arm after a lull or clear ending; ambient speech must not extend engagement. Keep all-speaker room transcription independent. Test wake, follow-up, pause, re-arm, dormant tag speech, side conversation and owner priority with fake brain and mixed-speaker events. Repo: Jester.",
      "dependencies": [
        "jester.03"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Add conversational attention. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.04a",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add transcript-only voice mode. Jester, just listen immediately stops current and queued speech and pending actions; continue transcribing everyone but make no Luna calls, spoken replies or EBI/tag actions. Only Drew can switch modes; Jester, talk again restores dormant conversation. Recognize mode commands deterministically while silent, preserve privacy Pause and leave controls, show mode in the transcript channel, survive a transient reconnect during the same owner presence and reset for a new presence. Test all-speaker transcripts and silence with fake brain and actions. Repo: Jester.",
      "dependencies": [
        "jester.04"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Transcript-only mode implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.05",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Let guests have ordinary conversations.. A guest who addresses Jester can talk and interrupt its reply, while private EBI facts and all control actions remain blocked in code; no model text can grant itself permission. Repo: Jester.",
      "dependencies": [
        "jester.04a"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-VOICE: Natural, prompt speech and safe guest conversation"
      ],
      "output": "Let guests have ordinary conversations. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-VOICE"
    },
    {
      "id": "jester.06",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Restore the transcript-channel post.. Create one attached Markdown transcript message per room session in Auto Transcripts and update that same message as turns arrive, with bounded update frequency and retry after a transient Discord failure. Keep the current allwork-compatible file. Repo: Jester.",
      "dependencies": [
        "jester.05"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-PRIVACY: Transcript channel, privacy pause and 30-day retention match the replaced service"
      ],
      "output": "Restore the transcript-channel post. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-PRIVACY"
    },
    {
      "id": "jester.07",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Restore recording privacy controls.. Show a clear room notice with Pause; anyone in the room can pause audio capture/transcription, only Drew can resume, and paused audio is never sent to STT or Luna or saved. Test both Discord identity and restart behavior. Repo: Jester.",
      "dependencies": [
        "jester.06"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-PRIVACY: Transcript channel, privacy pause and 30-day retention match the replaced service"
      ],
      "output": "Restore recording privacy controls. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-PRIVACY"
    },
    {
      "id": "jester.08",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Restore the 30-day transcript cleanup.. Prune only aged transcript files after checking the path and leave current sessions untouched; test with dated fixtures. Repo: Jester.",
      "dependencies": [
        "jester.07"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-PRIVACY: Transcript channel, privacy pause and 30-day retention match the replaced service"
      ],
      "output": "Restore the 30-day transcript cleanup. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-PRIVACY"
    },
    {
      "id": "allwork.09",
      "plan_id": "allwork",
      "plan_version": 1,
      "outcome": "Resolve allwork's trigger collision.. The installed allwork code still treats “Jester” as an idea trigger. After Drew chooses, activate the already-built Goku rename or disable that trigger; do not revive the canceled idea-saving feature. Check the installed skill copy and existing transcript parser. Repo: allwork, in its own safe copy.",
      "dependencies": [],
      "owned_files": [
        "ideas.py",
        "allwork.py",
        "tests/",
        "skill-install/",
        "SKILL.md",
        "CARD-trigger-filter.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-ALLWORK: Jester bot speech does not trigger the separate allwork workflow"
      ],
      "output": "Resolve allwork's trigger collision. implemented and checked in its repository copy",
      "acceptance_check": "python3 -m pytest -q tests/test_ideas.py tests/test_transcript.py",
      "source_requirement": "REQ-ALLWORK"
    },
    {
      "id": "ebi.19",
      "plan_id": "ebi",
      "plan_version": 1,
      "outcome": "Add a read-only tag/status endpoint to EBI.. Remove Jester's need to trigger tag reassignment or Discord renames just to answer a status question; keep the old API behavior for existing callers. Repo: EBI.",
      "dependencies": [],
      "owned_files": [
        "claude_discord/",
        "claude_code_core/",
        "tests/",
        "docs/"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add a read-only tag/status endpoint to EBI. implemented and checked in its repository copy",
      "acceptance_check": "uv run pytest -q tests/test_api_server.py tests/test_jester_voice_bridge.py",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "ebi.17",
      "plan_id": "ebi",
      "plan_version": 1,
      "outcome": "Add a pure stop-turn endpoint.. Add a narrowly scoped EBI endpoint that stops one exact active turn without sending a new prompt; verify it cannot stop another session or all sessions by accident. Repo: EBI.",
      "dependencies": [
        "ebi.19"
      ],
      "owned_files": [
        "claude_discord/",
        "claude_code_core/",
        "tests/",
        "docs/"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add a pure stop-turn endpoint. implemented and checked in its repository copy",
      "acceptance_check": "uv run pytest -q tests/test_api_server.py tests/test_jester_voice_bridge.py",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "ebi.20",
      "plan_id": "ebi",
      "plan_version": 1,
      "outcome": "Implement authenticated, scoped guest grant validation and authorized guest action paths at the EBI boundary; reject forged, expired, wrong-capability and wrong-thread grants without impersonating Drew.",
      "dependencies": [
        "ebi.17"
      ],
      "owned_files": [
        "claude_discord/",
        "claude_code_core/",
        "tests/",
        "docs/"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add guest authorization at EBI's boundary. implemented and checked in its repository copy",
      "acceptance_check": "uv run pytest -q tests/test_api_server.py tests/test_jester_voice_bridge.py",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.11",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Build an ID-safe EBI client.. Read real session state without losing Discord's long thread IDs in JavaScript; apply timeouts and one request in flight. Resolve a current tag and its spoken aliases to the canonical thread ID, then keep that ID for the conversation. Repo: Jester.",
      "dependencies": [
        "jester.08",
        "ebi.19"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions",
        "ebi.19: accepted checked result and exact interface contract"
      ],
      "output": "Build an ID-safe EBI client. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.12",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add read-only status questions.. “What is Zoro doing?” and “Who's running?” must query current EBI state and answer from facts, never Luna memory. Unknown or reused tags prompt a short clarification. Repo: Jester.",
      "dependencies": [
        "jester.11"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add read-only status questions. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.13",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add typed intent and policy checks.. Luna may interpret a spoken request into a small validated action schema, but deterministic code checks actor, exact target, action and risk before execution. Partial corrections such as “deploy—actually just test” must not trigger early actions; arbitrary shell from generated text is forbidden. Repo: Jester.",
      "dependencies": [
        "jester.12"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add typed intent and policy checks. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.14",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Message the right session. During an active Jester conversation, both Tell Zoro and a direct Zoro instruction send only the final corrected task through EBI /spoken with the real speaker identity, the exact resolved thread ID, and queue/interrupt semantics. A passing tag mention, dormant tag utterance or transcript-only speech sends nothing. Confirm the result aloud and prevent duplicate delivery after retry. Repo: Jester.",
      "dependencies": [
        "jester.13"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Message the right session. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.15",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Create and start sessions from speech. Resolve a named project through the project catalog, create one EBI thread with a correlation ID, send Drew’s spoken assignment to that exact new thread, then confirm its real name/tag and whether work started. A retry must not create a duplicate thread or repeat the assignment. Repo: Jester.",
      "dependencies": [
        "jester.14"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Create sessions from speech. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.16",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add close and model/backend changes.. Apply each only to a resolved thread through the existing EBI APIs, and clarify broad requests such as “stop everything.” Explain unsupported folder moves until EBI provides them. Repo: Jester.",
      "dependencies": [
        "jester.15"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions"
      ],
      "output": "Add close and model/backend changes. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.18",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Wire spoken stop to the exact turn.. Resolve the target ID and call the checked stop endpoint; acknowledge when the target is already idle. Repo: Jester.",
      "dependencies": [
        "jester.16",
        "ebi.17"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions",
        "ebi.17: accepted checked result and exact interface contract"
      ],
      "output": "Wire spoken stop to the exact turn. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.21",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Add temporary grants in Jester.. Only Drew can grant, revoke or make access permanent; default grants expire with the voice session and cover the named person, capability and session. Guests cannot re-delegate. Repo: Jester.",
      "dependencies": [
        "jester.18",
        "ebi.20"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-CONTROL: Exact-ID EBI control with deterministic owner and guest permissions",
        "ebi.20: accepted checked result and exact interface contract"
      ],
      "output": "Add temporary grants in Jester. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-CONTROL"
    },
    {
      "id": "jester.22",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Resolve conversational references.. “Tell him that too” binds to the last canonical thread ID, not a reusable Zoro/Nami tag. Search EBI history for past work by topic/time/project and ask when a match is genuinely ambiguous. Repo: Jester.",
      "dependencies": [
        "jester.21"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions"
      ],
      "output": "Resolve conversational references. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    },
    {
      "id": "jester.23",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Detect EBI events without brain polling.. Use the researched read-only SQLite turn journal for starts, finishes and likely failures; reconcile tags/running state through a bounded EBI API call. Handle schema drift, stale rows and restarts without making false announcements. Repo: Jester; use EBI events instead if the approved local EBI endpoint exists.",
      "dependencies": [
        "jester.22"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions"
      ],
      "output": "Detect EBI events without brain polling. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    },
    {
      "id": "jester.24",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Deliver events at the right moment.. Hold normal completions for a conversational gap, speak blockers/failures promptly, bundle routine updates, and persist meaningful missed events for one catch-up when Drew returns. Repo: Jester.",
      "dependencies": [
        "jester.23"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions"
      ],
      "output": "Deliver events at the right moment. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    },
    {
      "id": "jester.25",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Support simple requested dependencies.. “When Zoro finishes, tell Sanji to start” and “when both finish, tell me what I can test” store exact IDs and one-time actions, survive a restart, and do not launch twice or act on failed/ambiguous results. Repo: Jester.",
      "dependencies": [
        "jester.24"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions"
      ],
      "output": "Support simple requested dependencies. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    },
    {
      "id": "jester.26",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Shed idle load and report degradation.. When the room is empty, stop needless STT/TTS compute and release model resources where safe; wake without making Drew wait unreasonably. Report Codex capacity or local overload plainly without silently throttling EBI workers. Repo: Jester.",
      "dependencies": [
        "jester.25"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions"
      ],
      "output": "Shed idle load and report degradation. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    },
    {
      "id": "jester.27",
      "plan_id": "jester",
      "plan_version": 1,
      "outcome": "Finish an offline integration review of wake/re-arm, active-only direct tag routing, transcript-only mode, streaming voice, transcript privacy, allwork parsing, exact EBI actions, permissions, events and restart behavior. Record measured live checks and the owner feel test as pending rather than claiming they passed.",
      "dependencies": [
        "jester.26",
        "allwork.09"
      ],
      "owned_files": [
        "src/",
        "worker/",
        "scripts/",
        "tests/",
        "package.json",
        "README.md",
        "deploy/",
        "DECISIONS-LOG.md"
      ],
      "owned_resources": [],
      "required_inputs": [
        "REQ-EVENTS: History, meaningful events, dependencies and recovery survive long sessions",
        "allwork.09: accepted checked result and exact interface contract"
      ],
      "output": "Finish the replacement check. implemented and checked in its repository copy",
      "acceptance_check": "bash scripts/check.sh",
      "source_requirement": "REQ-EVENTS"
    }
  ]
}
```

## How to try it

1. Talk naturally in the Discord room for 10–15 minutes, pause mid-thought and interrupt Jester; it should wait and answer promptly.
2. Ask a guest to talk to Jester, pause recording, then check the Auto Transcripts post and saved file; paused speech must be absent.
3. Ask about Zoro, send one message, create a session and request a completion update; the exact intended session must be used.
