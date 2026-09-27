# STT Benchmark — 2026-09-27

Setup:
- RTX 4060 Laptop (8 GB), WSL with 4 threads.
- Test set: 73 LibriSpeech clips (481 s of read English speech, 16 kHz), transcribed one clip at a time the way Jester will transcribe finished turns.
- Settings: greedy decoding; one un-timed warm-up clip per engine.
- Raw numbers are in `results/stt.jsonl`. Reproduce with `bench_stt.py <engine>`.

## Results

- **Parakeet TDT 0.6B v2, GPU (onnx-asr)**: word errors **2.9%**, **128 ms** mean per clip (p90 161 ms, 114 ms on clips ≤5 s), 52× realtime. Peak GPU memory is ~4.0 GB total, including ~0.5 GB desktop baseline and the ONNX memory arena.
- **faster-whisper large-v3-turbo, GPU fp16**: 3.9% errors, 331 ms mean (p90 404 ms), 20× realtime, 2.4 GB peak.
- **faster-whisper small.en, GPU fp16**: 5.3% errors, 188 ms mean (p90 271 ms), 35× realtime, 1.2 GB peak.
- **faster-whisper small.en, CPU int8** (the current EBI setup): 5.6% errors, **2,336 ms** mean (p90 2,957 ms), 2.8× realtime, and it ties up all 4 WSL threads.
- **Parakeet v2, CPU**: 2.9% errors, 784 ms mean (p90 1,372 ms), 8× realtime.

## Takeaways

- **Parakeet v2 on the GPU is the STT pick.** It has the fewest errors and the lowest latency, and it keeps the 4 CPU threads free for EBI.
- The current CPU Whisper path is about 18× slower and would blow the ~1–1.5 s response budget on its own.
- Parakeet's ~4 GB peak is mostly ONNX arena headroom. It can be capped (`gpu_mem_limit` / `arena_extend_strategy`) if TTS needs the room, so re-measure once TTS shares the GPU.
- **Caveat:** this is clean read speech, not the owner's casual Discord audio. Re-run on a real owner recording before final lock-in.

## Setup gotchas (recorded so nobody repeats them)

- The driver is 576.28, which supports CUDA 12.9 only. `onnxruntime-gpu` ≥1.24 is built for CUDA 13 and silently fails to load its CUDA provider (`libcublasLt.so.13`), so it is **pinned to 1.23.x**.
- CUDA/cuDNN come from pip `nvidia-*-cu12` wheels inside `bench/.venv` (2.8 GB). Nothing was installed system-wide, and the EBI voice worker's Python was not touched.
- The pip `nvidia` libs are not on the loader path, so `bench_stt.py` preloads them (`add_nvidia_libs`).
