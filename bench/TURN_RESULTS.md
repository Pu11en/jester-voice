# End-of-Turn Benchmark — 2026-09-27

Question: can Silero VAD + Smart Turn v3.2 tell "finished talking" apart from "pausing to think" well enough for Jester?

## Method (`bench_turn.py`)

### Test turns
Built from the same 73 LibriSpeech clips, using word times from faster-whisper:
- **complete** (63): the full sentence followed by 3 s of silence. Jester should reply.
- **incomplete-any-word** (63): the sentence cut after a random word 30–80% of the way through, then silence. This simulates a thinking pause, so Jester should wait.
- **incomplete-function-word** (60): the same, but the cut lands after a word like "the", "and", "of" or "to". This is an obvious mid-thought pause.

### Simulation
- Audio is streamed in 32 ms frames through Silero VAD.
- After 200 ms of VAD silence (Pipecat's default), Smart Turn scores the audio so far: the last 8 s, zero-padded at the start.
- It checks once per pause. The first score above the threshold ends the turn.
- Read speech also has natural pauses at commas mid-sentence: about 0.7 per turn. These count too. A "complete" turn that gets cut at a comma is an early cut.

Raw per-check data is in `results/turn-{cpu,gpu}.json`.

## Results (GPU model `smart-turn-v3.2-gpu.onnx`, threshold 0.5)

- Speed: **17 ms per check on the GPU** (p90 26 ms), versus 58 ms on the CPU. Speed is not a problem.
- Finished sentences:
  - **38%** got a fast reply, about 320 ms after the last word.
  - **32% were cut early** at a mid-sentence comma pause.
  - 30% were never judged finished, so they fall back to the silence timeout.
- Thinking pauses:
  - After an obvious mid-thought word ("the", "and"...), only **8%** were wrongly cut. Good.
  - After a random word, **24%** were wrongly cut.
- Separation (AUC, 0.5 = coin flip): finished vs mid-thought is **0.79** for function-word cuts and 0.70 for any-word cuts. Finished vs mid-sentence comma pauses is **0.54**, barely better than chance.
- The CPU int8 model is clearly worse: AUC 0.64 / 0.58, and 29% of function-word pauses wrongly cut. **If Smart Turn is used, use the GPU model.**

Raising the threshold trades early cuts for slower replies: at 0.9, early cuts fall to 22%, but only 25% of turns get a fast reply.

## What this means

1. **Smart Turn alone does not meet Jester's bar on this data.** It would cut the owner off at roughly 1 in 4–3 pauses, and often still wait for the timeout.
2. **Caveat: this is audiobook reading, not conversation.** Smart Turn is trained on conversational speech to assistants. Read speech with commas that end in falling pitch is a known hard case. The owner's real speech could score much better or worse, so **a real owner recording is now the blocker** for a turn-detection decision.
3. Likely design, pending real-speech numbers: a **layered decision** instead of one model.
   - Smart Turn (GPU), **plus the Parakeet transcript at each pause** (about 130 ms, and a trailing "the/and/so/um" means keep waiting), **plus an adaptive silence timeout**: short when both agree the owner is done, about 2–3 s when unsure.
   - **Speculative start:** send the transcript to the brain at every pause, but only *speak* once the turn is confirmed. This hides brain latency without cutting the owner off. Discard the draft if the owner keeps talking.
4. The plain silence-timeout baseline is set by definition. A short timeout (≤0.8 s) cuts every longer thinking pause. The owner's median gap between utterances is 3.2 s (EBI transcript data). A long timeout (3 s) makes every reply wait 3 s. Neither meets the ChatGPT-Voice feel target, which is why the layered approach is needed.

## Bugs caught while building this
- Smart Turn expects **start-padding** (`smart-turn/audio_utils.py`). Letting the Whisper feature extractor pad at the end put the turn end in the middle of the window and made scores meaningless. `bench_turn.py` pads at the start.

## Owner's real speech (2026-09-27, same day)

The owner recorded 3 answers to Jester-style prompts with the local recorder page (`recorder/`). That is 118 s total: a long ramble, a Zoro instruction with a mid-sentence change of mind, and a question plus a request. Recorded in the browser with noise suppression on, not through Discord Opus. The audio and transcripts stay local (`data/owner/`, gitignored, because the repo is public).

Every pause inside a recording is a place where the owner **kept talking**, so a reply there would have cut him off. The end of each recording is a real finished turn.

### Pauses
- **35 mid-turn pauses**: median 0.61 s, p75 0.86 s, p90 1.45 s.
- Longest: **5.9 s**, straight after "I want you to…".
- 15 of the 35 pauses came right after a filler or connector word ("um", "like", "to", "the", "then", "basically"…).

### Plain silence timeout would cut him off
- 0.5 s: 23/35 pauses
- 0.8 s: 15/35
- 1.0 s: 8/35
- 1.5 s: 4/35
- 2.0 s: 2/35

### Smart Turn v3.2 (GPU) does far better on real speech than on audiobooks
- At threshold 0.5 it wrongly cut in on **1/35** pauses: a 0.5 s pause mid-sentence after a noun. Almost all mid-turn pauses scored below 0.1, including the 5.9 s one (0.014).
- It detected **2/3 finished turns** (0.69 and 0.55). The miss was the long ramble, which trailed off ("…and stuff like that") and scored 0.01. That one would fall back to the timeout.
- At threshold 0.7 or higher it catches no finished turns. **The threshold must stay around 0.5.**

### Speech-to-text on the owner's voice
- Parakeet v2 correctly heard "Zoro", "Nami" and "Go Work", and dropped most "um/uh".
- Whisper large-v3-turbo made up a trailing "Thank you." (the known Whisper silence habit) and wrote "Zorro".
- **Parakeet is confirmed as the STT pick.**

### Updated turn-detection design
- **Smart Turn GPU at threshold 0.5** is the main signal. On real speech it rarely interrupts.
- **Fallback timeout when Smart Turn isn't sure:** about 1.5–2 s normally. Extend to about 6–8 s when Smart Turn is very low (<0.05) *and* the last word is a connector ("to", "the", "and", "with"…). That covers the 5.9 s "I want you to…" pause.
- **Speculative brain start** at each pause stays in the design to hide latency, but Jester only speaks once the turn is confirmed.
- **Caveat:** 35 pauses and 3 turns is a small sample. Re-check during the first live Discord tests, and log every cut-in.
