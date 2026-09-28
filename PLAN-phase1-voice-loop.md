# Plan — Phase 1: Talk to Jester in Discord (the smallest real loop)

Check: bash /home/drewp/main-projects/jester-voice/scripts/check.sh
Try: cd /home/drewp/main-projects/jester-voice && npm start
Open: the Discord voice room from `VOICE_CHANNEL_ID` (Jester joins when the owner does)

Goal: the owner joins the voice room, Jester joins too, and they talk. Speech is heard (Parakeet), end of turn is detected (Silero + Smart Turn), Luna answers (Codex app-server), Kokoro speaks, and talking over Jester stops it immediately. EBI session control (Zoro/Nami, spawn, etc.) is **Phase 2**, a separate plan.

Everything is decided by the benchmarks in `bench/*_RESULTS.md`; read those before changing a component. Source of truth: `HANDOFF.md` + `REPLACES_OLD_VOICE.md`.

## Ground rules for every task
- **Layout:** Node 22 app in `src/` handles Discord I/O, orchestration and the brain client. The Python speech worker lives in `worker/` and handles VAD, Smart Turn, Parakeet and Kokoro on the GPU. They talk over the worker's stdin/stdout using JSON lines, with audio as base64 PCM.
- **Python:** reuse `bench/.venv` (it already has CUDA 12 wheels; `onnxruntime-gpu` is pinned to 1.23 because the driver only supports CUDA 12.9). Do **not** create another multi-GB venv, because C: is nearly full. Copy `add_nvidia_libs()` from `bench/bench_stt.py`.
- **Secrets:** read `DISCORD_BOT_TOKEN` and `DISCORD_OWNER_ID` from the EBI env file (`JESTER_EBI_ENV_FILE`, default `/home/drewp/main-projects/ebi-agent-chat-relay/.env`), the same way the old voice bot does. Guild/channel IDs go in `.env` (`DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID`, `DISCORD_TRANSCRIPT_CHANNEL_ID`); the values are in `~/.local/share/drew-ai-voice-transcripts/voice.env` as `VOICE_*`. Never commit `.env`; the repo is public.
- **Same bot token as EBI:** only one voice connection per bot per server. The old voice bot now only joins on `!voice join`, so it doesn't conflict as long as it isn't joined. Never run both in voice at once.
- **The check must never call Luna or Discord.** Use fakes. Live smoke scripts go in `scripts/smoke-*.sh`, run by hand.
- Commit after every task. Nothing goes to GitHub until the owner has tried it.

## Tasks

- [ ] **1. Scaffold + check script.**
  - Create `package.json`: Node ≥22.12, ESM, `node --test`, and dependencies `discord.js@14.27.0`, `@discordjs/voice@0.19.2`, `@discordjs/opus@0.10.0`, `prism-media@1.3.5`, `@snazzah/davey@0.1.12`. These are the versions proven in the old extension.
  - Create `src/config.mjs` (loads both env files, validates, never logs secrets), `worker/__init__.py`, `worker/tests/`, and `.env.example` with the variables above.
  - `scripts/check.sh`: `cd` to the repo, `npm test --silent`, then `bench/.venv/bin/python -m pytest -q worker/tests`. It must pass in under 2 minutes, with one trivial test on each side.
  - Add `node_modules/` to `.gitignore` if it's missing.
- [ ] **2. Speech worker: listening.**
  - `worker/speech.py` reads JSON lines on stdin: `{"op":"audio","speaker":id,"pcm":b64}` (16 kHz mono s16, 32 ms frames) and `{"op":"reset","speaker":id}`.
  - Per speaker it runs Silero VAD (`bench/data/models/silero_vad.onnx`, 32 ms frames) and emits `speech_start`, then `pause` after 200 ms of silence.
  - At each pause it runs Smart Turn v3.2 GPU (**pad at the start**, keep the last 8 s) and Parakeet v2 GPU on the utterance. It emits `{"ev":"pause","speaker","prob","text"}`.
  - Turn end: prob > 0.5 means `turn_end` right away. Otherwise fall back after 1.8 s of silence, or after 7 s if prob < 0.05 and the last word is a connector (to/the/and/with/of/um/uh/like/so/but/or/because).
  - Emit `{"ev":"turn_end","speaker","text","ms":{...}}` with timings.
  - Pytest: feed a committed test WAV. Generate it with Kokoro in `worker/tests/data/`; do not commit owner audio. Assert one `turn_end` with the expected words, and no `turn_end` when the WAV is cut mid-sentence with a 1 s pause.
- [ ] **3. Speech worker: speaking.**
  - Add `{"op":"say","id","text"}`: Kokoro GPU (`af_heart`, `bench/data/models/kokoro-v1.0.onnx`) streams sentence chunks as `{"ev":"audio_out","id","pcm":b64}`, 48 kHz **stereo** s16, ready for Discord. It ends with `{"ev":"say_done","id"}`.
  - Add `{"op":"cancel","id"}`: stop generating and drop queued chunks.
  - Pytest: first chunk in under 800 ms after warm-up, and cancel stops output within one chunk.
  - Cap Parakeet's ONNX arena with `gpu_mem_limit` so both fit in 8 GB, and log peak VRAM at startup.
- [ ] **4. Brain client (Node).** `src/brain.mjs` wraps `codex app-server`, following `bench/bench_brain.py`, which is proven.
  - Use the lean flags, `thread/start` with a Jester `baseInstructions` persona (spoken, 1–2 sentences, never fake EBI facts), `ephemeral:true`, read-only sandbox and approval `never`.
  - API: `prewarm()`, `ask(text, {speaker}) → async iterator of sentence strings` (split streamed deltas at sentence ends), `interrupt()`, `injectContext(text)`.
  - Stall cue: emits `thinking` if no word has arrived after 2.5 s.
  - `node --test` uses a **fake app-server script** (a tiny Node process speaking the same JSON-RPC) and never the real model.
  - Add `scripts/smoke-brain.sh` for one live call, run by hand only.
- [ ] **5. Discord voice I/O (Node).** `src/voice.mjs`:
  - Log in with discord.js (intents: Guilds, GuildVoiceStates) and `joinVoiceChannel` with `selfDeaf:false, selfMute:false`, plus DAVE debug logging (copy the pattern from `drew-ai-voice-runtime/extensions/voice_transcripts/src/transport.mjs`).
  - Receive: subscribe per user, decode Opus → 48 k stereo → **16 k mono** frames → worker. Skip bots and Jester itself.
  - Playback: `AudioPlayer` fed from a PCM stream per reply. `stopNow()` stops playback immediately, and it tracks how many ms of each reply actually played.
  - Unit-test the resample/downmix and the "played ms" math.
  - Add `scripts/smoke-voice.sh`: joins, plays a 1 s tone, leaves. Run by hand only.
- [ ] **6. Conversation loop.** `src/conversation.mjs` wires worker ↔ brain ↔ voice, **owner-only for now** (guests are ignored this phase).
  - **Speculative start:** on the owner's `pause` with prob > 0.3, start `brain.ask`, but hold the audio until `turn_end`. If speech resumes, discard the draft (`interrupt`) and merge the text into the next ask.
  - **Barge-in:** a `speech_start` from the owner while Jester is speaking triggers `voice.stopNow()` + worker `cancel` + `brain.interrupt()`. Record only the words actually heard, estimated from played ms, as Jester's turn in context via `injectContext`.
  - **Stall:** on `thinking`, play a short "mm, one sec" from a cached clip.
  - Log each turn to `logs/turns.jsonl`: end-of-speech→first-audio ms, STT ms, brain first-word ms, TTS first-chunk ms, and barge-in stop ms.
  - Tests use fakes for all three parts, covering the speculative-discard, barge-in and stall paths.
- [ ] **7. Presence.**
  - Auto-join when the owner joins `DISCORD_VOICE_CHANNEL_ID`, and leave when the owner leaves.
  - "Jester, leave" / "Jester, disconnect" (owner, clearly addressed; bare "leave"/"stop" must **not** trigger it) makes Jester leave and not auto-rejoin during this owner presence.
  - Text escape hatch: owner types `!jester leave` / `!jester join` in the transcript channel. Needs the `GuildMessages` + `MessageContent` intents; check that the bot already has them.
  - Prewarm the brain thread on join. Test the state machine with fakes.
- [ ] **8. Room transcripts (replaces the old bot's).**
  - Write every speaker's `turn_end` text, plus Jester's *heard* replies, to `~/.local/share/drew-ai-voice-transcripts/runtime/transcripts/<session-id>.md`. Use the **exact** old format: header lines `- Session:`, `- Channel:`, `- Started:`, `- Ended:`, and lines `**HH:MM:SS — Name:** text` in UTC.
  - Use a new session id per voice presence.
  - Test: parse the output with `allwork`'s own regexes (`LINE_RE`, `STARTED_RE` from `~/main-projects/automate 247/allwork/transcript.py`). Guests are transcribed too, but not answered this phase.
- [ ] **9. Run it for real.**
  - `npm start` runs Node, which spawns the worker, restarts it if it dies, and shuts down cleanly on SIGINT.
  - Add `deploy/jester-voice.service` (a systemd user unit with `Restart=always`, not enabled yet) and short README "run it" steps.
  - Check that both `smoke-*.sh` scripts still pass by hand.
  - Hand over to the owner for the feel test below. Don't touch or stop `drew-ai-voice-transcripts.service`; that cut-over comes after the owner approves.

## How to try it
1. Make sure the old voice bot isn't in the room (type `!voice leave` if it is), run `npm start`, then join the voice room. **Jester should join within a few seconds.**
2. Say "Jester, can you hear me?" in your normal voice, with a pause mid-sentence if you like. **It should answer out loud in about 2 seconds or less, and not cut you off mid-thought.**
3. While Jester is talking, start talking over it. **It should go quiet immediately, then answer what you said.**
