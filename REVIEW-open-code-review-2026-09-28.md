# Jester code review with Alibaba OpenCodeReview

September 28, 2026. Used [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) CLI v1.12.10 in delegation mode. `ocr delegate preview --format json --from ff50e20 --to 54ebc33` selected 15 changed code files; `ocr delegate rule --format json` supplied its file rules. Codex reviewed those files and the excluded service unit and project notes. OCR did not call an LLM or use an API key; the CLI ran through `npm exec`, without a global installation. The preview and rules are saved under ignored `sim/results/`.

## Confirmed defects and changes

1. **One-turn session creation was intercepted as an unfinished draft.** `CreateDraft.consume()` ran before the one-turn intent parser, so “Jester, create a session in Jobs to review the LinkedIn profile” asked for a task instead of creating the session. Reproduced with both parsers. Complete create intents now go to the existing checked project and spawn route. The `one-turn-create` simulation proves one exact fake spawn.
2. **An abandoned draft could steal a later instruction.** After “open a session in Jobs,” a Zoro status question left the Jobs draft pending. “Tell it to review the login page” then spawned Jobs instead of addressing the bound Zoro thread. Reproduced with `CreateDraft` and the intent parser. Drafts now clear on unrelated intent or speech, after the attention window ends, and when another speaker takes the floor. The `abandoned-create` and `abandoned-create-chat` simulations check that no stale spawn occurs.
3. **A failed project lookup could reject outside the voice handler’s error boundary.** The multi-turn creation branch called `OwnerRouter.handle()` without the catch used by the normal branch. A lookup failure could become an unhandled rejection from the event callback. Both branches now return the same spoken error. The `create-error` simulation injects a lookup failure and checks for no EBI write.
4. **Natural Zoro questions missed checked status routing.** “What is going on with Zoro?” and “Help me with Zoro’s audit” returned no structured intent. They now read the checked session state and recent thread evidence. The `natural-zoro` simulation checks both phrases and no EBI write.

## Verification and limits

`node sim/run.mjs`: **15/15 scenarios passed**. `bash scripts/check.sh`: **114 Node tests and 6 speech tests passed**. The review page at `http://localhost:8798/` now shows the five added scenarios; existing review marks remain in `sim/results/review.json`.

These checks use fake Discord, Luna and EBI. The recorded Jobs case still stops after Jester asks for the task; it does not prove an actual end-to-end Jobs instruction. Current live Jester has not loaded these source changes, and its speech worker has repeated ONNX memory failures. The 100-session snapshot limit, crash-safe outbound action identity and real audio/EBI path also remain unverified. Keep real project work off Jester until those gates pass.
