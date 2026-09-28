# Jester voice behavior gap audit — 2026-09-28

This compares `HANDOFF.md` and `REPLACES_OLD_VOICE.md` with the current Phase 1 code and the paused completion plan. It records product behavior, not permission to start the scheduled build.

## What works today

- Jester auto-joins with Drew, receives per-speaker audio, transcribes owner and guest speech into an allwork-compatible room file, uses local turn detection and voice, answers Drew through Luna, and can be interrupted.
- Drew can say `Jester, leave` or use typed join/leave controls. The old transcript bot is archived; its existing transcript history remains on disk.
- These are component and short live checks. The required 10–15 minute natural-conversation feel test has not passed.

## Conversation behavior missing or incomplete

- **Dormant wake and re-arm are absent.** `Conversation.#turnEnd` sends every completed owner utterance to Luna after only checking the leave command. Saying `Jester` is not required. There is no engaged speaker state, contextual follow-up window, or return to dormancy after a lull. Guest turns are transcribed and then ignored. The revised attention task now checks waking, natural follow-ups, re-arming, side talk, and owner priority separately from transcription.
- **Transcript-only mode is absent.** There is no voice command or mode state for `Jester, just listen`; every owner utterance can still trigger a reply. A new separate task now requires everyone to keep being transcribed while Luna replies, TTS, and EBI/tag actions are fully blocked. Only Drew switches modes; deterministic exit/leave and privacy Pause remain available.
- **Timing and speech flow need repair.** The conversation layer buffers all Luna sentences until the answer ends before starting TTS. The stall sound can play during a tentative thinking pause. Brain failure is only logged rather than spoken. Current measured median end-of-speech to first audio is about 2.8 seconds across eight live turns, versus the handoff's roughly 1.5-second goal.
- **Shared-room nuance is not implemented.** Guests cannot yet converse; speaker-specific engagement, overlap priority, false barge-in filtering, and uncertainty handling need the planned offline checks and the live feel test. A guest must never obtain private EBI status or control merely by talking.

## Replacement and session-work gaps

- **Transcript parity:** files work, but the edited Discord Auto Transcripts post, recording notice, Pause/owner resume, 30-day pruning, and allwork's still-active `Jester` idea trigger have not been replaced or resolved. The revised plan keeps these as explicit tasks. Transcript-only means recording continues; privacy Pause means recording stops.
- **Hands-off EBI work:** Jester cannot yet resolve a spoken tag to an exact live session ID, report status, send a task, create **and start** a new session, stop/close/change it, bind pronouns to the exact session, find past work, give completion/failure updates, or run a requested dependency like “when Zoro finishes, tell Sanji.” The plan covers each as typed, identity-checked operations. Creating a new empty thread alone is insufficient; the revised creation task includes sending the assignment and confirming work started.
- **Long-running reliability:** state and meaningful missed events must recover after restart, stale tags must not be reused as identities, guest grants must be checked at the EBI boundary, and no unattended job may silently switch to a paid brain. The existing plan covers these but completion must be demonstrated with offline checks and a supervised live acceptance pass.

## One product boundary still to settle

- **Direct tag while dormant:** the old bot treated `Zoro, ...` as an immediate command, while the new owner clarification says a fresh conversation starts with `Jester`. The current handoff supports tag navigation during an active Jester conversation but does not settle whether a tag itself wakes Jester after a lull. Decide this before accepting the EBI routing behavior. Until then, require `Jester` to wake a dormant conversation and never dispatch a tag command from ambient speech.

OpenAI's current [Voice guidance](https://help.openai.com/en/articles/20001274-chatgpt-voice) describes natural back-and-forth and interruption but notes that background or other-speaker speech may cause unintended responses. Its [voice-agent guidance](https://developers.openai.com/api/docs/guides/voice-prompting) explicitly treats side conversations and speech not addressed to the assistant as non-speaking turns. Jester's explicit dormant gate and transcript-only mode are Drew's requirements and must be enforced by Jester code, not assumed to come from a model.
