# Jester owner live-check list

These are Drew's first checks after the local build is integrated and the live service is safely updated. Interruption already works and is not a separate first-check item. Guest conversation and guest session control are out of scope.

## A — Wake and natural follow-ups

- Start speaking without Jester's name: keep the transcript, make no reply or EBI call.
- Say `Jester` and ask something; then ask a follow-up without its name. Jester answers both.
- Say something addressed to another person; Jester stays quiet and does not extend the 60-second follow-up window.
- After 60 seconds without an accepted Jester exchange, a new request needs `Jester` again.

## B — `Jester just listen`

- Say exactly `Jester just listen` without a comma. The comma variant also works.
- Jester stops speaking and pending actions, keeps transcribing everyone, and makes no Luna or EBI calls.
- Say `Jester talk again`; Jester returns to dormant mode and waits for its name before replying.

## C — Find and control the right EBI session

First run C against fake EBI sessions and receipts. In Discord, use a clearly identified harmless test session and one benign prompt chosen by Drew; do not send a test assignment to an unrelated live work thread. Check the room transcript against the exact prompt posted in the destination thread.

1. **Find:** Ask `What is Frankie doing?` Jester recognizes `Frankie` as the current `franky` tag, reads real EBI status, and names the exact session. `Who's running?` lists current work. Unknown or reused names lead to one short clarification and no action.
2. **Send:** During an active Jester conversation, say `And Frankie, we need to [benign test task]` or directly address `Frankie, ...`; Jester waits for the complete thought, strips only filler and superseded corrections, and posts one faithful prompt to Frankie's current exact thread ID. A passing mention of Frankie or a dormant `Frankie, ...` sends nothing. Repeat the direct-address fake check for every current tag/alias so the attention gate cannot special-case only Zoro.
3. **Correct:** Say `Frankie—actually Zoro—[benign test task]`, or change `deploy` to `just test` before the turn ends. The final target and final instruction win; the superseded destination receives nothing. If the target changes while waiting, recheck it before sending.
4. **Follow up:** `Tell him to add tests` refers to the last exact bound thread ID during the active 60-second exchange, even if a reusable tag later points elsewhere. An unclear `him` leads to clarification, never a guessed send.
5. **Create and navigate:** Ask for a new session in a named project and give it a task in the same sentence. Jester resolves the actual project, creates one thread with the prompt as its first turn, reports its real tag/thread, and can find it again by topic or project. A requested backend/model applies before that first turn.
6. **Control:** On a disposable session, try an exact target model change, stop-current-turn, and close. The action touches only that session; stop sends no extra prompt, close does not affect another thread.
7. **Track:** Jester distinguishes accepted, posted/started, finished, failed, and unknown. A request timeout, replayed transcript, reconnect, or retry never makes a duplicate thread post or starts the task twice. A completion or blocker is reported from EBI evidence, not Luna memory.
8. **Block modes:** Repeat a harmless tag instruction while `Jester just listen` is active or after the 60-second window ends. It appears in the transcript but sends no work.

The [primary-source routing research](planning/wayfinder-jester/research/voice-session-routing-patterns.md) maps these checks to established dialog, Discord identity, tool-call, and idempotency patterns. This checklist is an acceptance target, not a claim that C is implemented in the current live Jester.
