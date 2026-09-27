# Machine Inspection — 2026-09-27

Read-only inspection of the owner's Lenovo (START_HERE step 2). Nothing was installed or changed.

## Hardware

- Lenovo 83EG (Slim 5), Windows 11 Pro 10.0.26200.
- CPU: AMD Ryzen 7 7840HS, 8 cores / 16 threads.
- RAM: 32 GB physical.
- GPU: **NVIDIA GeForce RTX 4060 Laptop, 8 GB VRAM** (driver 576.28, CUDA 12.9), plus Radeon 780M iGPU. ~0.5 GB VRAM in use at idle.
- Disk: WSL root has 750 GB free. **Windows C: is 100% full (8.9 GB free)** — do not put models or Docker data on C:.

## WSL / Docker

- WSL 2.7.12, Ubuntu 24.04, kernel 6.18. `.wslconfig`: `memory=20GB`, `swap=12GB`, `processors=4`, mirrored networking.
- **WSL only gets 4 of 16 threads.** That is the biggest CPU constraint for local STT/TTS alongside EBI; raising `processors` is an owner decision (needs `wsl --shutdown`).
- GPU is visible inside WSL (`/dev/dxg`, `/usr/lib/wsl/lib/nvidia-smi`). No CUDA toolkit, cuBLAS or cuDNN installed in WSL.
- Docker 29.7.2 inside WSL, `nvidia` container runtime present (not default). Sees 4 CPUs / 20 GB. Only `crawl4ai-server` running.

## Toolchain

- Node 22.22.0, npm 11.19, pnpm 11.8 (no bun).
- Python 3.12.3, pip 26, uv 0.11.2.
- FFmpeg 6.1.1, git 2.43, gh 2.86.
- Codex CLI 0.157.1, Claude Code 2.1.283.

## Existing speech components

- Python (user site): faster-whisper 1.2.1, ctranslate2 4.7.1 (reports 1 CUDA device), openai-whisper, whispercpp, onnxruntime 1.24.4 (CPU), torch 2.11 **CPU-only**, discord.py 2.7.1, edge-tts, gTTS.
- Cached models (`~/.cache/huggingface/hub`): faster-whisper base, base.en, small, small.en.
- No Silero VAD, Smart Turn, Kokoro, Piper or other local TTS installed.
- Running EBI voice worker uses faster-whisper `small.en` on **CPU int8** (~550 MB RSS). GPU faster-whisper would need cuBLAS/cuDNN (e.g. `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheels) — untested.

## Brain (Codex subscription)

- Codex logged in via ChatGPT subscription (no API key). Default model in config: `gpt-6-astra`, reasoning `low`.
- **`codex exec -m gpt-6-luna` works** (replied correctly). That one-word call reported ~18k tokens used, because `codex exec` loads the global AGENTS.md and tool context — the brain bridge must use a lean context, not plain `codex exec`.
- Latency/streaming not yet measured (START_HERE step 6).

## EBI runtime

- `ebi-agent-chat-relay.service` (systemd user unit, `Restart=always`): `~/main-projects/ebi-agent-chat-relay`, runs `claude_discord.cli start`. Control API at `http://127.0.0.1:9876` (`CCDB_API_URL`).
- `drew-ai-voice-transcripts.service` (`Restart=on-failure`): the live voice extension runs from **`~/main-projects/drew-ai-voice-runtime`** (a separate checkout of `ebi-agent-chat-relay`, commit 9a73272), not from the main relay folder. It holds a flock at `~/.local/share/drew-ai-voice-transcripts/worker.lock`.
- Also present: `ebi-agent-chat-relay-preserved-local`, `ebi-discord-check`.
- Supervisor precedent: systemd user units already auto-restart EBI, so a systemd unit is a proven restart path for Jester too.

## Implications for Jester

- GPU is the obvious home for STT/TTS (8 GB is enough for Whisper small/medium + a small TTS), keeping WSL's 4 CPU threads free for EBI.
- Enabling GPU inference is a small install (CUDA runtime wheels or the Docker `nvidia` runtime), not a driver change.
- Reuse the cached faster-whisper models; don't redownload.
- Next steps per START_HERE: inspect EBI interfaces (step 3), AllGit research (step 4).
