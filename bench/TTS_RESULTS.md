# TTS Benchmark — 2026-09-27

Four typical Jester replies (one to two short sentences), streamed, with one un-timed warm-up. CPU engines were limited to 2 threads to leave room for EBI. Raw numbers are in `results/tts.jsonl`. Listening samples are in `samples/` (gitignored). The run was cut short by a machine crash, so Pocket `marius` was not measured.

## Results
- **Kokoro 82M, GPU (kokoro-onnx), `af_heart`**:
  - First audio after **279 ms** on average (max 404 ms).
  - 17× realtime.
  - **0.06 CPU-seconds per second of speech.**
  - About 1.2 GB of GPU memory.
- **Kokoro, GPU, `am_michael`**: first audio after 390 ms (max 515 ms), 13× realtime.
- **Kokoro, CPU**: first audio after 1,872 ms, which is too slow.
- **Pocket TTS, CPU, `alba`**:
  - First audio after **120 ms** (max 152 ms), 2.5× realtime.
  - Cancels in 21 ms.
  - But **1.07 CPU-seconds per second of speech**, so a full core is busy the whole time Jester talks.

## Pick: Kokoro on the GPU, voice `af_heart`
- Its first audio arrives about 160 ms later than Pocket's, which is well inside the ~1–1.5 s reply budget. In return it uses almost no CPU, so WSL's 4 threads stay free for EBI.
- GPU memory fits: Parakeet (~4 GB peak, cappable) + Smart Turn + Kokoro (~1.2 GB) stays under the 8 GB card.
- Kokoro streams one sentence at a time, so "cancel" means dropping the queued sentences. Barge-in stops *playback* instantly either way, in the Discord player, without waiting on TTS.
- The owner delegated the voice choice ("just pick one"). `af_heart` is Kokoro's top-rated English voice. The TTS adapter stays swappable, and Pocket TTS is the fallback if GPU memory gets tight.
