# Jester stabilization checkpoint

Owner approved continued local Jester + EBI review/repair in checked batches.
This candidate is NOT deployed. Main baseline: `f804d995`; candidate branch:
`fix/jester-stabilization-20260928`, worktree:
`/home/drewp/.local/state/ccdb/session-wt/jester-stabilization-20260928`.
Installed node_modules is reused by symlink; Python checks use the existing main
`bench/.venv`. No packages/models installed, live writes or paid calls authorized.

Full cross-repository briefing and next-session prompt:
`/home/drewp/main-projects/ebi-agent-chat-relay/handoffs/2026-09-28-jester-ebi-stabilization.md`.
The EBI OpenSpec change `stabilize-session-reliability` holds the combined plan.

## Checked findings

| ID / priority | Reproducer and impact | Candidate repair |
| --- | --- | --- |
| JV-01 / P1 | Leave -> stop process -> owner absent at restart -> next visit. Saved dismissal stayed true because initial absent state bypassed presence transition; Jester never joined the next visit. New test failed `true !== false`. | Clear and persist the ended visit's dismissal when startup observes the owner absent; keep same-visit dismissal and privacy pause intact. `src/presence.mjs`, `src/presence.test.mjs`. |
| JV-02 / P1 | Simulation leave constructed real Presence with default operational paths. Intercepted leave boundary in a regression (no real write) observed the live `presence.json` path. Running unpatched simulations can persist a fake dismissal into live service state. Historical impact not proven. | Give every simulation run/scenario temporary presence/privacy state; clean only its mkdtemp directory. New safe regression exercises the boundary. `sim/run.mjs`, `sim/run.test.mjs`. |
| JV-03 / P1 | Single-source dependency accepted an invalid completion date and dispatched; invalid failure date blocked it; temporary/nonterminal failure also permanently blocked it. Three independent offline cases failed. | Require finite newer event/creation timestamps and terminal failure evidence, matching the grouped workflow's intended policy. Positive recovery and final-failure controls retained. `src/dependencies.mjs`, tests. |
| JV-04 / P2 | Conversation.close returned with evidence writes still queued; tests logged ENOENT after temporary files were removed. A controlled blocked log queue proved close returned early. | Drain the owned log queue before returning from shutdown. Regression checks both waiting and persisted action identity. `src/conversation.mjs`, tests. |
| JV-05 / P1 | Overlapping identical actions could reuse an in-memory journal row while its first save was pending. A failed save still let the spoken route POST with an ID that was never durable; failed `finish` exposed an unsaved `posted` state, and a rejected write poisoned every later save. Four temporary-file/fake-EBI regressions reproduce these cases. | Serialize duplicate decisions and disk writes. Publish new in-memory state only after atomic rename succeeds. Keep the caller's write failure visible while allowing later attempts to recover. `src/action-journal.mjs`, tests. |
| JV-06 / P1 | From review of `5653e5e` (persisted dismissal). Three offline regressions: (a) a failed dismissal write made `leave()` throw before muting/disconnecting, so Jester stayed in the room after the owner asked it to leave; (b) two concurrent rejoin requests after a leave both connected (3 connects vs 2); (c) owner departure after a leave, with a failed write, raised an unhandled rejection from the Discord event handler (fatal by Node default). All three failed first. | A failed dismissal write is logged and never blocks leaving, departure or rejoining. `join()` claims its in-flight promise before any await. Startup still fails closed on an unreadable state file, matching the privacy file (lead, not changed). `src/presence.mjs`, tests. |
| JV-07 / P1 | From review of `e53aa95`. (a) The natural-language proposer's "exact span" check was only `endsWith`: a model proposal of `art the server` for "…restart the server", or a punctuation-only instruction, passed and would be sent verbatim. (b) An identical task repeated within the journal window returned the old receipt as "I posted your task", though nothing new was sent. Both failed first. | The proposed span must contain a letter/number and start on a word boundary. A reused receipt now says the task was already posted and not sent again; a genuine same-ID resend after a missing receipt still says posted. `src/intent-proposer.mjs`, `src/owner-router.mjs`, tests. The deliberate-repeat product policy (dedupe window vs. intentional re-send) stays an owner decision. |
| JV-08 / P2 | Result watch: when the Auto Transcripts post succeeded but saving `reportPosted` failed (disk error), the failure was handled like a failed post and the attachment was re-posted on every poll (3 posts in the regression). | Post failure and mark failure are separate; a successful post is remembered in-process, so only the save is retried. Across a crash between post and save the attachment can still repeat once (at-least-once); speech stays gated by the saved delivery mark. `src/event-watcher.mjs`, test. |
| JV-09 / P2 | Credential boundary: the Codex brain (which reads untrusted thread text) and the speech worker inherited Jester's whole environment. The deployed unit keeps secrets in files, so this is exposure only when started from a shell that exports `DISCORD_BOT_TOKEN` / `JESTER_EBI_API_SECRET` / `CCDB_API_SECRET`. RED: the brain spawned without an explicit environment. | `src/child-env.mjs` removes those keys from both child environments; everything else (PATH, CODEX_BIN, models dir) is kept. `OPENAI_API_KEY` is deliberately untouched pending an owner decision on the subscription-only auth path. |

No live incident is attributed to these mechanisms without corresponding live evidence.
All regressions use temporary state and fake service boundaries. The simulation RED
test intercepts leave specifically so proving the bug cannot mutate live state.

## Verification record

- Main baseline rerun: 133 Node tests passed; 7 Python worker tests passed (42.00s).
  Node output included asynchronous turn-log ENOENT warnings after temp cleanup:
  investigate ownership/draining; do not represent the warning gate as clean.
- Presence + conversation focused checks passed after JV-01 (dot reporter).
- Dependencies + watcher + simulation harness focused checks: 18 passed.
- Candidate with JV-01/02/03: 138 Node tests, 7 Python tests (9.08s), and all
  16 isolated simulation scenarios passed. After JV-04: **139 Node tests passed
  in 6.12s**, with no turn-log ENOENT output. Expected injected outage messages
  and Node's experimental MockTimers warning remain visible, not suppressed.
- Final JV-04 rerun: **16/16 isolated simulations and 7 Python tests passed
  (6.73s)**. `git diff --check` passed. Local fix commits: JV-01 `8185665`,
  JV-02 `ff252bb`, JV-03 `0892200`, JV-04 `7c5769a`. No push, main integration,
  service restart or live-state repair.
- JV-05 was first RED: four regressions failed in the baseline. The focused
  action-journal/router suite passed **23 tests** after the fix. The full Node suite
  passed **143 tests**, the worker Python suite **7**, and the isolated simulator
  reported **16/16**. `git diff --check` passed. These are offline checks only.
- JV-06 (September 29): three presence regressions failed first (leave threw
  before disconnect; concurrent rejoin connected twice; departure produced an
  unhandled rejection). After the fix: **146 Node tests, 7 Python tests (22.19s),
  16/16 isolated simulations**; `git diff --check` passed. Offline only.
- JV-07: two regressions failed first. After the fix: **148 Node tests, 7 Python
  tests (10.94s), 16/16 isolated simulations**; `git diff --check` passed.
- JV-08 and the pending-speech coverage test: **150 Node tests, 7 Python tests,
  16/16 isolated simulations**; `git diff --check` passed.
- JV-09 plus two absent-owner coverage tests: **153 Node tests, 7 Python tests,
  16/16 isolated simulations**; `git diff --check` passed. (One new watcher test
  first passed vacuously because the start-up poll was still running; it now
  waits for that poll and asserts each tick really runs.)
- The shared pre-commit hook runs Lefthook, but this project has no Lefthook config;
  it reports that and exits successfully. The checks above were run explicitly.
- No saved human `sim/results/review.json` was present in main at review time.
- The three functional commits `5653e5e`, `e53aa95`, `5f16221` now have a
  behavior-level review with verdicts below; it is not a line-by-line proof.

## Functional-commit review (September 29)

Reviewed by behavior against current owner-V1 decisions; each confirmed defect
was reproduced offline before its repair. Verdicts are for the candidate branch.

| Commit | Verdict | Confirmed defects (repaired) | Remaining leads, not yet reproduced |
| --- | --- | --- | --- |
| `5653e5e` session answers, presence persistence, OOM restart | Accept with JV-01, JV-06 | JV-01 (restart-absent dismissal), JV-06 (failed dismissal write blocked leave/departure; double rejoin) | Unreadable `presence.json` aborts startup (fails closed like `privacy.json`; product choice). Session-read evidence relies on prompt instructions against injected thread text; no adversarial corpus. OOM `SystemExit(2)` restart path has no fault-injection test. |
| `e53aa95` owner commands, intent proposer, action journal | Accept with JV-05, JV-07 | JV-05 (journal concurrency/storage), JV-07 (clipped proposal span; repeat reported as a new post) | Journal rows are never pruned (unbounded file growth). A `pending` row matches forever, so a crash-leftover identical request reconciles against the old ID. Proposer still cannot see constraints spoken before the extracted span. |
| `5f16221` stale failure guards | Accept with JV-03 | JV-03 (single-source timestamps; same class as this commit's group guard) | Group completion without any turn timestamp falls back to "now"; saved group items without `createdAt` bypass the newer-than check. |

EBI commits named in the handoff: `726ecaf` (explicit empty spawn) — accept; one
confirmed defect repaired in the EBI candidate: `spawn_session(auto_start=True)`
with no prompt created the Discord thread before rejecting it (orphan thread).
`48f67d5` (single-thread spawn uses `VoiceTagger.tag_thread`) — accept; superseded
and hardened by candidate commit `8406035`. Minor: the spawn response returns the
thread's pre-tag name.

## Requirement-to-evidence inventory

Product source: recent decisions and named sections of `HANDOFF.md` (H),
`SCOPE-jester-owner-v1-before-trial.md` (S), `REPLACES_OLD_VOICE.md` (R), and
`LIVE-CHECK-jester-owner.md` (L). Recent owner decisions override old guest/proactive
sections. This is an initial inventory, not proof that the audit is exhaustive.

OFFLINE means only the stated synthetic boundary has evidence; it never means
actual room audio or a real EBI operation. UNTESTED identifies missing/insufficient
evidence. FAIL refers to the baseline, even when a candidate fixes it. DEFERRED
is a product decision, not a way to hide a missing current requirement.

| Requirement / source | Implementation | Existing exact test anchor / evidence | Remaining gap |
| --- | --- | --- | --- |
| Owner arrival/departure (H Presence) | presence.mjs | presence.test: `joins and prewarms when owner arrives...` — OFFLINE | Actual Discord cache/event sequencing |
| Intentional leave, no same-visit rejoin (H Presence) | presence.mjs | `spoken leave remains dismissed...`; JV-06 `owner leave disconnects even when the dismissal cannot be saved`, `concurrent rejoin requests after a leave connect once`, `owner departure after a leave survives a failed dismissal save` — OFFLINE | Voice disconnect API failure itself |
| Restart absent then new visit (H Presence/recovery) | presence.mjs | JV-01 — FAIL baseline; candidate regression pass | Live activation |
| Owner typed escape hatch (H Presence) | presence.mjs | `text escape hatch is restricted...` — OFFLINE | Live permissions |
| Same-presence reconnect preserves transcript (H mode/R) | presence.mjs | `rejoins after voice transport failure...` — OFFLINE | Concurrent leave/join races |
| Dormant speech: transcript, no brain/action (H attention) | attention/conversation.mjs | conversation.test: `dormant room speech and guest wake words...` — OFFLINE | Recognition false wakes in room |
| Wake once, natural follow-ups (H attention/S) | attention.mjs | attention.test: `only a direct Jester address wakes...` — OFFLINE | Natural speech diversity/feel |
| Side conversation/lull/end stops engagement (H attention) | attention/conversation.mjs | `ambient speech does not extend...`, `explicit side talk...` — OFFLINE | Acoustic/multi-person trial |
| Engaged tag instructions; mentions do not act (H direct tags) | owner-intent/conversation.mjs | `named owner task routes...`, `finds read-only status requests...` — OFFLINE | Wider ambiguous phrasing corpus |
| Finality, dropped audio and corrections (H spoken text) | conversation/owner-intent.mjs | `dropped owner audio...`, `final corrected task wins...` — OFFLINE | Real STT constraints/final corrections |
| Faithful natural proposal (H spoken text) | intent-proposer/owner-router.mjs | `natural assignment becomes...`, `discussion, invented task text...`; JV-07 `a proposed instruction must be whole owner words...` — OFFLINE | Constraints before extracted span |
| Exact speaker authority (H permissions) | conversation/owner-router.mjs | `reads current session facts and ignores another speaker` — OFFLINE | End-to-end Discord speaker attribution |
| Ambiguous target asks, no guessed action (H authority) | owner-router/ebi-client.mjs | `unknown, duplicate, closed, and numeric IDs...` — OFFLINE | Whole-flow clarification correctness |
| Names/Frankie resolve canonical string ID (H tags/L) | ebi-client.mjs | `resolves Frankie to the current exact string ID...` — OFFLINE | Live tag pool currently inconsistent in EBI |
| Pronouns bind ID, not recyclable label (H tags) | owner-router.mjs | `posts one faithful task...binds follow-up`, `tag reassigned...` — OFFLINE | Rebind during journal/receipt awaits |
| Current status/result grounded (H brain) | session-reader/owner-router.mjs | `reads the substantive result...`, `reports missing evidence...` — OFFLINE | Prompt-injection and clipping review |
| Historical reference (H historical) | owner-router/ebi-client.mjs | `history lookup uses EBI search...` — OFFLINE | Natural time/topic disambiguation corpus |
| Verified project + create first task (H creation) | owner-router/ebi-client.mjs | `creates a Codex session only in a verified project...` — OFFLINE | Cross-repo backend/model-before-first-turn proof |
| Create/runtime backend and model choice (H creation/control) | owner-intent/owner-router/ebi-client.mjs | same create test passes `backend: "claude", model: "sonnet"`; `runtime change and close apply only to the named session` — OFFLINE | EBI applying model before the first turn is covered only by EBI-side tests, not an end-to-end run |
| Empty create invents no task (S/L) | owner-router/ebi-client.mjs | `an explicit empty session creates no invented first task` — OFFLINE | Current tag exhaustion/live receipt |
| Stop/close/runtime exact target (H control) | owner-router.mjs | `stop sends no prompt...`, `runtime change and close...` — OFFLINE | EBI lifecycle/runtime continuity defects remain |
| Truthful accepted/posted/unknown receipts (H brain/S) | owner-router/ebi-client.mjs | `lost spoken response...`, `missing EBI receipt...`; JV-07 `a repeated identical task says it was not sent again` — OFFLINE | Owner policy for deliberate repeats inside the 5-minute window |
| Stable retry identity, no duplicate create (H recovery) | action-journal/owner-router.mjs | `uncertain action keeps its identity...`, `lost session creation...`, JV-05 disk failure/concurrency regressions — OFFLINE | Process-level multi-writer and fsync/power-loss assumptions; completed-action repeat policy |
| Just-listen deterministic; cancels audio/actions (H mode) | conversation/dependencies.mjs | `just listen cancels current and queued speech...` — OFFLINE | Actual self-mute and in-flight POST boundary |
| Talk-again dormant; new visit reset (H mode) | conversation/presence.mjs | `talk again restores dormant conversation...` — OFFLINE | Exact process-restart versus transport-reconnect behavior |
| Pause captures nothing; guest pause/owner resume (H privacy/R) | presence/voice/conversation.mjs | `room member can pause...`, `recording pause discards buffered speech...` — OFFLINE | Actual Discord capture/audio boundary |
| Stream first sentence before later composition (H speech) | conversation/brain.mjs | `accepted first sentence reaches Kokoro...` — OFFLINE | Real TTS first-audio timing |
| Barge-in cancels queued speech and brain (H barge-in) | conversation/voice/brain.mjs | `barge-in stops audio...`, `discards sentences...` — OFFLINE | Measured interruption latency/noise robustness |
| Context reflects actually heard speech (H barge-in) | conversation/voice.mjs | `records only estimated heard words`, `counts only time spent...` — OFFLINE | Estimate vs actual audio and disconnected playback |
| All speakers + one editable transcript attachment (H/R) | transcript/conversation.mjs | `writes all speakers...`, `posts one edited Auto Transcripts attachment...` — OFFLINE | Real allwork ingestion and interrupted end marker |
| Retention confined to transcript files (R) | transcript.mjs | `prunes only old transcript files inside its directory` — OFFLINE | Inspect retention clock and failure handling |
| Requested once-only fixed-ID watches (H dependencies/S) | dependencies/event-watcher.mjs | `named result group tracks every exact ID...`, `three-session result watch...`; JV-08 `a posted result is not posted again when saving that fact fails` — OFFLINE | A crash between Discord post and saved mark can repeat the attachment once |
| Single-source temporary error recovery (H dependencies) | dependencies.mjs | JV-03 — FAIL baseline; candidate regressions pass | Invalid saved group state still to review |
| Quiet by default, no absent brain polling (H cost/S) | event-watcher/presence/index.mjs | `completed turns stay quiet by default...`; `an absent owner costs no brain warm-up, connection or reconnect attempts`; `while the owner is away, finished work is neither spoken nor posted` (added Sept 29, passed first run) — OFFLINE | Real idle-process resource use over hours |
| One subscription path, no paid fallback (H Brain) | brain/intent-proposer.mjs, child-env.mjs | brain.test: `hung turn kills the stale app-server...`; JV-09 `the Codex brain never inherits Discord or EBI credentials` — OFFLINE | Whether Codex could fall back to an `OPENAI_API_KEY` in the environment is not tested (owner decision) |
| Bounded pending speech output (H performance/resources) | conversation.mjs `MAX_PENDING_TTS_BYTES` | `a stalled player drops the reply once 8 MB of speech is pending` (added Sept 29; passed on first run, coverage only) — OFFLINE | Real Discord player stall behavior and memory under long sessions |
| Worker timeout/restart/idle resource release (H recovery/cost) | worker-client/index.mjs | worker-client.test: restart, suspend, queue bounds, timeout — OFFLINE | Long-run memory and concurrent load |
| DAVE/decrypt/transport recovery (H performance) | voice.mjs | Prior warning only — UNTESTED | Reproduce warning/fault injection and authorized room check |
| Total/component latency and feel (H performance/L) | conversation/worker/voice | `turn metrics are logged` only — UNTESTED performance | Measured distributions, concurrent load, 10–15-minute owner trial |
| Simulation cannot change production (verification contract) | sim/run.mjs | JV-02 — FAIL baseline; candidate boundary test passes | Complete filesystem/network boundary audit |
| Guest conversation/control/grants (H latest scope) | deliberately out of V1 | DEFERRED | Guest transcript/privacy above remains required |

## Next work

Finish the three-commit adversarial review and missing per-requirement mappings.
JV-04 covers queued turn-log writes at shutdown; JV-05 covers action-journal
concurrency and storage failures. Further lifecycle producers still need review.
Investigate the result-report post/mark crash window, journal process-level writer
and fsync assumptions, and lifecycle/routing races. Reproduce before repair; do not
convert review leads into confirmed bugs without tests. Run only the patched
isolated simulator, not main's unpatched version. Keep live audio/performance checks
separate.
