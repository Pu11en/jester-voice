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
