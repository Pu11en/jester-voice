# Jester owner conversation and action contract

September 28, 2026. **Proposed behavior for Drew to review.** Some exact text examples now pass the [offline simulator](sim/README.md); that does not prove real speech or full owner V1 readiness. This document turns the owner V1 scope and the failed Zoro/Jobs trial into concrete conversations that can become replay tests. [The full scope](SCOPE-jester-owner-v1-before-trial.md) remains the source for all required capabilities. Guests can appear in the room transcript but guest conversation and session control are outside V1.

## One rule for every turn

Discord supplies the speaker ID. Speech recognition supplies text, with an uncertainty signal. Jester decides `ignore`, `answer`, `ask`, or `act`. Luna may propose meaning and help phrase an answer, but Jester code checks owner, current mode, finality, exact project/thread ID, and the authorized action before any EBI write. A mention, an unfinished thought, an uncertain transcript, or a question about work never becomes a task. An action gets one durable ID and one checked EBI receipt. The spoken confirmation names the state actually observed: *posted*, *queued*, *running*, *finished*, *failed*, or *unknown*.

An exchange starts when Drew says “Jester.” Drew's real follow-ups can omit the name for at most 60 seconds; an ending or side/guest conversation closes the exchange earlier. A tag alone does not wake a dormant Jester. Ordinary room speech is transcribed under the agreed notice, without Luna, EBI, or spoken output. Session events stay silent unless Drew asks or sets a one-time result watch.

## Conversation 1: ambient talk, then Zoro

Assume Jester is in the room, dormant, and EBI has a historical Zoro thread in Drew's Audit with recent messages.

| Heard in order | Expected response | Reads and writes |
| --- | --- | --- |
| Drew to another person: “I think Zoro did the audit.” | Silence. Remain dormant. | Transcript only; no Luna or EBI. |
| Guest: “Hey Jester, what did Zoro do?” | Silence in V1. | Transcript only; no EBI. |
| Drew: “Jester, what is Zoro doing?” | “Zoro isn't running now. Its last work in Drew's Audit was [verified task/result]. [Verified blocker or unknown if none visible].” | Resolve Zoro to one exact thread ID; read fresh state and bounded recent messages/turn results; zero writes. Do not reduce this to “Zoro is history.” |
| Drew: “What did it finish?” | Give the verified latest result and any limits of what Jester can see. | Reuse the bound thread ID within this exchange; refresh evidence; zero writes. |
| Guest starts a separate conversation; Drew later says “Tell him to do the next page.” | Silence because the exchange ended and “him” is no longer bound for action. | Transcript only; zero writes. |

If the name maps to two threads, Jester asks which one and does not read a guessed thread as authoritative. If the API cannot fetch recent work, it says the status it *can* verify and that the details are unavailable. Search must work beyond today's 100-session snapshot cap.

## Conversation 2: discuss a project without assigning work

> **Drew:** “Hey Jester, help me figure out what we could do with Drew's audit. I mean Zoro.”
>
> **Jester:** “I found Zoro in Drew's Audit. It last [verified result]. Do you want to talk through next steps, or give Zoro a task?”
>
> **Drew:** “Let's talk through it first.”
>
> **Jester:** Discusses the checked audit context and possible next steps. No task is sent.

Expected decision: `answer`, bound to Zoro's exact ID, with fresh EBI evidence supplied to Luna. There are **zero** `/spoken` or `/spawn` POSTs. Jester never says it lacks access to the audit when the checked EBI context is available. If the audit reference is ambiguous, it asks one short question first.

## Conversation 3: create work over several turns

> **Drew:** “Jester, open a session in Jobs.”
>
> **Jester:** “What should that session work on?”
>
> **Drew:** “It's for LinkedIn. I have something to add.”
>
> **Jester:** “Go ahead.”
>
> **Drew:** “Have it update my profile and publish it—actually, just review the profile and list suggested changes. Don't publish anything.”
>
> **Jester:** “I posted a review task to new Jobs session [actual tag]. It's [verified queued/running state].”

Before the final complete instruction, Jester holds one draft (`project=Jobs`, topic `LinkedIn`) and creates **zero** threads. It resolves Jobs through the project catalog, preserves the final correction, creates exactly one thread, and posts one first task: “Review Drew's LinkedIn profile and list suggested changes. Do not publish or change the profile.” It records the action ID before the EBI request and checks the returned thread ID and first-turn state. If project resolution is ambiguous, unavailable, or remote, it reports that rather than choosing a same-named local folder. If Drew explicitly says “Open an **empty** Jobs session now; I'll give it a task later,” Jester creates one empty thread and confirms that it is empty. That path requires an EBI empty-spawn capability; today's API requires a prompt.

## Conversation 4: correct the target and task before dispatch

The prior exchange is still active:

> **Drew:** “And Frankie, we need to change the site—wait, Zoro, just review the login page and give me test ideas. Don't edit files.”
>
> **Jester:** “I posted that review request to Zoro.”
>
> **Drew:** “Tell him to include mobile login.”
>
> **Jester:** “I posted that follow-up to Zoro.”

Only the final target, Zoro, receives the first prompt. Frankie gets **zero** requests. The first prompt carries the explicit no-edit constraint; Jester does not add a deployment or fix task. “Him” binds to Zoro's exact thread ID in this active exchange, not to whatever session later owns the Zoro tag. Queue is the default delivery mode. “Posted” means EBI accepted and placed the message in that thread; it does not mean the agent completed it. A request to read back the drafted prompt pauses dispatch until Drew revises or says to send; routine clear requests do not need a mandatory readback.

## Conversation 5: status and one-time follow-on work

> **Drew:** “Jester, update me on my sessions.”
>
> **Jester:** Gives a short summary of current tasks, states, and blockers; puts a labeled fuller list in Auto Transcripts if there are too many to say naturally. It does **not** turn on routine spoken notifications.
>
> **Drew:** “When Zoro and Sanji finish, tell me what I can test.”
>
> **Jester:** Confirms one watch for those two exact thread IDs. When both have verifiable final results, reports **once** with testable outputs.
>
> **Drew:** “When both finish, tell Frankie to check the links.”
>
> **Jester:** Uses “both” only if the immediately active context unambiguously means Zoro and Sanji; otherwise asks which sessions. It stores the destination Frankie's exact ID. After both succeed, it sends one checked prompt and reports the receipt. Failure or unclear completion stops the automatic handoff and produces an accurate status on request.

The first status question is read-only. Result watches and dependencies persist exact source/destination IDs and action IDs across a Jester restart. No repeated announcement or second send occurs after reconnection. EBI agents keep working if Jester leaves.

## Conversation 6: modes, leave, and recovery

> **Drew:** “Jester, just listen.”
>
> **Jester:** Immediately stops speech, self-mutes in Discord, and marks transcript-only mode in the transcript channel. It transcribes permitted room speech from everyone; no Luna calls, replies, or EBI actions.
>
> **Drew:** “Jester, talk again.”
>
> **Jester:** Unmutes into **dormant** mode; no speech acknowledgement. A new “Jester” address is required to converse.
>
> **Drew:** “Jester, leave.”
>
> **Jester:** Stops output and disconnects without making an EBI action or automatically rejoining the same presence.

Anyone present can invoke the existing privacy Pause; while paused there is no capture. Only Drew resumes. A same-presence restart restores a safe silent mode and closes/marks interrupted transcripts correctly. An incomplete or low-confidence recognition cannot cause a session write. An EBI timeout leaves the action **unknown** until Jester looks up the same saved operation ID; it never retries with a new ID and risks duplicate work.

## What repo helps, and what “training” means here

There is no verified drop-in repo that knows Drew's Discord identity, Jester wake/mode rules, EBI tag semantics, and EBI receipts. **Recommendation: keep the existing Jester repo and make these conversations executable replay fixtures against fake EBI state.** This is behavioral training *for the implementation and its tests*, not retraining Luna's model. Each fixture checks the exact `ignore/answer/ask/act` decision, canonical target ID, final prompt, number of EBI reads/writes, receipt interpretation, and spoken claim. Real trial transcripts become new fixtures before fixes. Add audio fixtures for wake, pause, corrections, overlap, and barge-in after the text/action path passes. This yields a repeatable regression suite instead of a fresh live-room debug cycle for each phrasing.

Relevant public references, checked September 28, 2026:

| Repo | Useful part | Fit for Jester now |
| --- | --- | --- |
| [discordjs/discord.js `@discordjs/voice`](https://github.com/discordjs/discord.js/tree/main/packages/voice) and [voice examples](https://github.com/discordjs/voice-examples) | Discord send/receive and connection examples. | **Keep** the installed Discord transport. Its README warns that Discord receive is undocumented, so Jester still needs real-room validation. |
| [LiveKit Agents](https://github.com/livekit/agents-js) and [testing guide](https://docs.livekit.io/testing/unit-tests/) | Strong multi-turn, mock-tool and voice-agent test patterns; its [simulations](https://docs.livekit.io/testing/simulations/) test whole conversations. | **Borrow the testing method, not the runtime** for V1. Agents join LiveKit rooms, while Jester lives in Discord; adopting it needs a bridge and rework. Its cloud simulations also need a LiveKit Cloud project and can incur cost, so do not enable them by default. |
| [Pipecat](https://github.com/pipecat-ai/pipecat) | Mature audio frames, turn strategies and interruption patterns; [integration guide](https://github.com/pipecat-ai/pipecat/blob/main/COMMUNITY_INTEGRATIONS.md) even describes behavioral evals. | **Reference only** unless Jester's existing audio pipeline still fails after a focused repair. A Discord transport is not established by the sources checked here, and moving the Node/Discord app into a Python pipeline adds a second integration problem. |
| [OpenAI Agents SDK voice pipeline](https://github.com/openai/openai-agents-python/blob/main/docs/voice/pipeline.md) | STT → agent → TTS reference. | **Do not adopt** for current V1: its voice pipeline has no built-in streamed-input interruption handling, and its default speech models use OpenAI API clients rather than Jester's existing local speech plus subscription-backed Luna path. |

This recommendation is an architectural inference from the linked project documentation and Jester's local code, not a claim that the public repos were run against Jester. The exact examples above are specifications; they need implementation and offline replay before another real-project trial. The owner V1 scope also requires STT memory recovery, safe voice attention, full tag lookup, truthful status, durable receipt reconciliation, and a supervised disposable-thread end-to-end check. Those cannot be solved by model prompting alone.

## Proof gate before Drew uses Jester on real work

1. Every scripted turn above passes offline with fake EBI, including zero-action cases, correction, ambiguous tag, >100 sessions, uncertain timeout, and restart; the trace shows why each decision happened.
2. A long two-speaker local audio run shows stable recognition and attention under normal machine load, without the ONNX memory failure seen in the first trial.
3. One supervised disposable live thread proves recognized final words → exact prompt → exact destination → durable receipt → actual worker state → accurate spoken confirmation. Then test on-demand status, just-listen, leave, and recovery.
4. Only after that proof should Drew use it as the commander for a real project. A real voice feel check remains necessary; no offline repo guarantees a perfect first try.
