# Jester Replaces the Old Voice Bot — What Must Carry Over

**Decision (owner, 2026-09-27):** the old voice-transcripts bot (`drew-ai-voice-transcripts.service`, running from `~/main-projects/drew-ai-voice-runtime/extensions/voice_transcripts`) will be **removed entirely**. Jester becomes the only bot in the voice room.

This overrides HANDOFF.md's "Jester should not create a second permanent room-transcript system". There will be no first one anymore, so **Jester owns room transcripts**.

Inventory taken read-only on 2026-09-27. On 2026-09-28, at the owner's request, the old `drew-ai-voice-transcripts.service` was stopped and disabled. Its unit was moved out of systemd's user unit directory, and the source and unit were saved under `~/.local/share/jester-voice/archive/old-drewai-voice-20260928-0604/`. The original source remains in the EBI checkout because that checkout has unrelated uncommitted changes. Existing transcript files remain in place. The main EBI Discord bot is still running. Jester's Phase 1 service was then enabled and started; it writes compatible transcript files, but the old spoken EBI commands remain unavailable until Phase 2.

## What the old bot does today

1. **Joins the voice room**, on the owner's `!voice join` / `!voice leave` / `!voice` commands in the transcript channel (changed from auto-join earlier on 2026-09-27).
2. **Records and transcribes everyone speaking** (bots excluded), with per-speaker names and times. It uses CPU faster-whisper `small.en` through a SQLite job queue.
3. **Writes a transcript file per voice session** to `~/.local/share/drew-ai-voice-transcripts/runtime/transcripts/<session-id>.md`. There are 26 files there now, and they are **pruned after 30 days** (`VOICE_RETENTION_DAYS`).
   - Header: `- Session:`, `- Channel:`, `- Started:`, `- Ended:`, pending/failed counts.
   - Lines: `**HH:MM:SS — DisplayName:** text` (UTC times).
4. **Posts that transcript to the Discord "🎙️ Auto Transcripts" channel** as an attached `.md`, and edits the same message in place as speech is processed.
5. **Privacy notice with a Pause button.** Anyone in the room can pause recording; after that, only the owner can restart it.
6. **Sends voice commands to EBI sessions.** Saying a tag ("Zoro, …") starts a "run" that is sent to that session through `/api/threads/{id}/spoken` after 10 s of silence. It also posts a "Listening for X" line that turns into a "sent" confirmation.
7. **Other voice commands:** switch a session's model/backend ("switch to opus"), start a new session in a folder, and close unused sessions ("tidy up", up to 25).
8. **Tag roster message** in the transcript channel, listing the current Zoro/Nami/… tags. It is refreshed about every 60 s.

## Who depends on it

- **allwork** (`~/main-projects/automate 247/allwork`, skill at `~/.agents/skills/allwork`) reads the transcript `.md` files directly (`transcript.py`, `TRANSCRIPT_DIR` = the path above). It parses the exact line format and treats `Kidquick360` as Drew.
  - **If transcripts stop, "allwork" stops working.**
  - allwork's own "Jester" voice trigger (`ideas.py` matches "Jester" plus mishearings) would also collide with Jester the bot. A shelved patch renames that trigger to "Goku" (see the allwork memory note).
- **EBI main bot:** does not read transcripts. It only receives `/spoken` messages, and Jester will call the same endpoint.
- Nothing else in `~/main-projects` reads the transcript files or database. Other hits are docs/plans only.

## What Jester must cover (so nothing is lost)

- **Room transcripts (new requirement).**
  - Transcribe everyone who speaks, not only speech directed at Jester. Parakeet on the GPU (~130 ms per turn) makes this cheap compared with today's CPU Whisper.
  - Write the **same `.md` format to the same folder** (or a folder allwork is pointed at) so allwork keeps working unchanged.
  - Include Jester's own spoken replies as lines, e.g. `**HH:MM:SS — Jester:** …`, so transcripts show both sides.
- **Discord transcript channel post.** Keep the edited-in-place `.md` post in 🎙️ Auto Transcripts, or replace it with something better. At minimum, don't silently drop it.
- **Privacy notice + Pause.** Guests must still be able to see they're being recorded and pause it. Only the owner can resume.
- **Join/leave control.** Jester's spec says it auto-joins when the owner joins and leaves on "Jester, disconnect", with a manual `/leave` escape hatch. That replaces the `!voice join/leave` commands, which the owner added earlier on 2026-09-27 to stop *unwanted* auto-joining.
  - **Decided 2026-09-27 (owner picked A):** Jester auto-joins when the owner joins the voice room. "Jester, leave" (or "disconnect") makes it leave, with no auto-rejoin during that same owner presence. Keep a typed escape hatch for failures. `!voice join/leave` is not carried over.
- **Voice → EBI sessions** (tag messages, model/backend switch, new session, close/tidy). These are already in Jester's spec as typed Jester Control actions, now conversational instead of a 10-second silence window.
- **Tag roster.** Jester can simply answer "who's running?" out loud. The channel roster message is optional and can be kept cheaply.
- **Retention.** Keep the 30-day pruning, or whatever the owner prefers.

## Side effects of the switch

- ✅ **No new Discord bot is needed.** Once the old voice process is gone, Jester can use the existing DrewAI bot token for voice, the same way the old extension did alongside the main EBI bot. That removes the "create a second bot" step.
- ⚠️ **Cut-over order matters:** stop the old voice service → start Jester with the same token → confirm transcripts are still written → then delete the old service. Never run both in the voice room at once (one voice connection per bot per server).
- ⚠️ **allwork's "Jester" trigger word** should move to the shelved "Goku" patch at cut-over, otherwise every "Jester, …" to the bot also counts as an allwork idea trigger.
- The old bot's audio and transcript history stays on disk until its 30-day pruning. Nothing is migrated or deleted by this plan.
