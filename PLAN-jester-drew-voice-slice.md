# Jester Drew-only conversation slice

Check: bash scripts/check.sh
Try: systemctl --user start jester-voice.service
Open: Drew's configured Discord voice room

Goal: Fix the existing voice loop so Drew can address Jester naturally, continue without repeating its name, and switch to transcript-only mode. Keep room transcripts and existing owner leave controls. Other speakers are transcribed under the agreed room policy, but Jester does not converse with them or grant EBI access in this slice.

Use one fresh safe repository copy per checkbox. Offline checks use a fake brain and fake Discord voice; they do not call Luna, enter Discord, restart the live service, or touch EBI. Integrate only checked local changes. This slice is ready to start now and does not depend on later session-control decisions.

- [ ] Stream the first completed Luna sentence to Kokoro after Drew's turn is accepted; keep speculative speech silent during a pause, then stream later sentences as they arrive. A fake slow brain proves first audio can start before the full answer exists. Check: bash scripts/check.sh
- [ ] Play the cached thinking cue only after an accepted turn has waited at least 2.5 seconds for a brain word. A tentative pause, interruption, or already-spoken cue must not trigger another cue. Check: bash scripts/check.sh
- [ ] Tell Drew briefly when Codex/Luna is unavailable, using a local cached audio response, while deterministic leave/privacy controls still work. No paid API or other model fallback. Check: bash scripts/check.sh
- [ ] Add a Drew-only attention state: on join or after a lull, ordinary room speech is transcribed but never sent to Luna; `Jester` engages it, Drew's follow-ups need no repeated name, and ambient speech does not keep the exchange alive. After a lull or clear ending, require `Jester` again. A dormant `Zoro, ...` never dispatches work. Check: bash scripts/check.sh
- [ ] Add `Jester, just listen`: stop current and queued speech, then transcribe everyone without Luna replies or EBI/tag actions. Only Drew can change modes; `Jester, talk again` restores dormant conversation. Keep owner leave controls available, ensure the later recording Pause gate can still override capture, and reset the mode for a new owner voice presence. The later transcript-channel task will display the current mode. Check: bash scripts/check.sh

## How to try it

1. Talk in the room without saying Jester; it should keep the transcript but stay quiet. Say `Jester` and ask a question, then follow up without repeating the name.
2. Pause mid-thought and then interrupt Jester. It should wait for your complete thought and stop talking when you speak over it.
3. Say `Jester, just listen`; everyone should still be transcribed while Jester stays silent. Say `Jester, talk again` to restore normal conversation.
