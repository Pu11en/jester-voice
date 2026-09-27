# Voice Component Research — 2026-09-27

START_HERE step 4. I searched the owner's AllGit catalog (local `all-git` MCP) for every job listed in HANDOFF.md, then ran narrower follow-ups (TTS, Whisper, Parakeet/Moonshine, Kokoro, full-duplex, Pipecat/LiveKit, voice cloning). License and activity were checked with `gh api` on the same day. Nothing was installed.

The catalog is keyword-based and TTS/STT-heavy. It surfaced **no Discord voice, VAD or turn-detection projects** and did not contain HF `speech-to-speech`. Those candidates come from HANDOFF.md and were checked directly.

The fit notes are for an **RTX 4060 with 8 GB VRAM and WSL capped at 4 CPU threads** (see MACHINE.md). The brain is remote (Codex/Luna), so no local LLM should use VRAM.

## Shortlist to benchmark

### Speech-to-text
- **faster-whisper (already installed)**: small.en/base.en are cached. It is currently CPU-only; moving it to the GPU needs the cuBLAS/cuDNN wheels. It is the baseline to beat.
- **Parakeet TDT 0.6B v2 (English)** via `mudler/parakeet.cpp` (MIT, active today) or NeMo/ONNX.
  - Close to Whisper-large accuracy and much faster. Streaming mode and word timestamps. CPU or GPU.
  - HF speech-to-speech also uses it by default.
  - **Top STT candidate.**
- `TheStageAI/TheWhisper` (MIT): a streaming Whisper runtime. Secondary.

### Turn detection / VAD (from HANDOFF, not in AllGit)
- **`snakers4/silero-vad`** (MIT, active): the standard speech/no-speech gate for barge-in and utterance start.
- **`pipecat-ai/smart-turn` v3** (BSD-2): a semantic end-of-turn model.
  - 8 MB int8 on CPU, roughly 10–65 ms per check.
  - It judges whether the speaker is *finished*, not just silent. This is the key to tolerating the owner's long thinking pauses (median 3.2 s between utterances).
  - **Top turn candidate.**

### Text-to-speech
- **`kyutai-labs/pocket-tts`** (MIT, active today): 100M params, CPU-only, **audio streaming, ~200 ms to first chunk, uses 2 cores**, voice cloning. Leaves the GPU free.
- **Kokoro 82M** via `remsky/Kokoro-FastAPI` (Apache-2.0, active): natural for its size; ready-made CUDA and CPU Docker images; OpenAI-style speech endpoint with streaming.
- **`ysharma3501/LuxTTS`** (Apache-2.0): under 1 GB VRAM, ~150× realtime on GPU, voice cloning. Streaming support is unclear, so verify it.
- **`QwenLM/Qwen3-TTS`** (Apache-2.0): about 97 ms latency claimed; HF s2s default. Heavier, so check VRAM.
- Second tier: `k2-fsa/OmniVoice` (Apache-2.0), `samuel-vitorino/sopro` (Apache-2.0), `0xShug0/audio.cpp` (C++ multi-model engine; license unclear).

### Whole-pipeline engines (Direction A)
- **`huggingface/speech-to-speech`** (Apache-2.0, active today).
  - Modular VAD → STT → LLM → TTS, served as an **OpenAI-Realtime-compatible WebSocket/WebRTC server**. Defaults are Parakeet and Qwen3-TTS.
  - The LLM slot talks to an OpenAI-style API, so it needs a small Codex/Luna shim.
  - Fully-local mode budgets ~8 GB for the speech models alone plus a local LLM. We'd skip the local LLM.
  - Discord would feed it via a bridge.
- **`pipecat-ai/pipecat`** (BSD-2, very active; not in AllGit).
  - A framework built around interruptions/barge-in, Silero VAD, Smart Turn, and pluggable STT/TTS/LLM.
  - Python, so a Discord audio bridge would be needed; Discord receive stays in Node (`@discordjs/voice` + DAVE).
  - A strong Direction A alternative.
- `bolna-ai/bolna` (MIT): telephony-oriented voice agent framework. Lower fit.

## Rejected / not a fit
- **`NVIDIA/personaplex`**: full-duplex, but it is its own speech-LLM brain, which conflicts with the Codex/Luna brain decision. It also needs more VRAM.
- **`fikrikarim/parlor`**: Mac/MLX only. Local Gemma brain.
- `Qwen3-Omni`, `hibiki-zero`, `MisoTTS` (8B): too heavy for 8 GB alongside other work, or the wrong role.
- Voice-cloning studios (`VoiceStudio`, `voicebox`, `Spark-TTS`, `dots.tts`): batch/production tools, not realtime.
- Dictation apps (`chirp`, `ghost-pepper`, `yap`, etc.): useful as evidence only. Parakeet is the reusable part.
- `MoonshineFlow`: its repo link is dead. Moonshine itself remains a possible small-STT fallback.

## Proposed benchmark plan (step 5)
1. **STT**: faster-whisper small.en (GPU) vs Parakeet TDT 0.6B v2. Measure latency and word error rate on real clips of the owner's speech. The EBI voice store keeps transcripts but deletes the audio after transcription, so a short fresh recording of the owner (normal speech with thinking pauses) is needed. The existing transcripts can still supply realistic sentences and pause timing.
2. **Turn detection**: Silero VAD + Smart Turn v3 vs a plain silence timeout. Replay the same real clips and count false cut-offs during thinking pauses.
3. **TTS**: Pocket TTS vs Kokoro vs LuxTTS. Measure time-to-first-audio, cancel speed, and CPU/GPU cost. Then generate the **same sample sentences in each voice for the owner to listen to**.
4. **Engine**: prototype Direction B (thin Jester core: Node Discord I/O + a Python voice worker using the winners above). Compare it against wrapping HF speech-to-speech or Pipecat, based on how much barge-in/turn logic each gives for free.
