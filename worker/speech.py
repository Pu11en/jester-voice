"""Streaming speech recognition and end-of-turn detection for Jester.

The process accepts one JSON object per line on stdin. Audio payloads are raw,
16 kHz mono signed 16-bit PCM, in 32 ms frames. Events are JSON lines on stdout.
Model loading is lazy to keep the state machine testable without a GPU.
"""

from __future__ import annotations

import base64
import ctypes
import glob
import json
import os
import site
import sys
import threading
import time
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512  # Silero v5's 32 ms frame at 16 kHz.
FRAME_BYTES = FRAME_SAMPLES * 2
MAX_UTTERANCE_FRAMES = 60 * SAMPLE_RATE // FRAME_SAMPLES
VAD_START_THRESHOLD = 0.5
VAD_CONTINUE_THRESHOLD = 0.35
PAUSE_MS = 200
TURN_THRESHOLD = 0.5
NORMAL_TIMEOUT_MS = 1_800
CONNECTOR_TIMEOUT_MS = 7_000
CONNECTORS = {"to", "the", "and", "with", "of", "um", "uh", "like", "so", "but", "or", "because"}
OUTPUT_RATE = 48_000
PARAKEET_GPU_MEM_LIMIT = int(os.environ.get("JESTER_PARAKEET_GPU_MEM_LIMIT", str(3 * 1024**3)))


def _models_dir() -> Path:
    return Path(os.environ.get(
        "JESTER_MODELS_DIR", "/home/drewp/main-projects/jester-voice/bench/data/models"
    ))


def add_nvidia_libs() -> None:
    """Preload CUDA/cuDNN wheels, matching bench/bench_stt.py."""
    for root in site.getsitepackages():
        for lib in sorted(glob.glob(os.path.join(root, "nvidia", "*", "lib", "*.so*"))):
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass


class SileroVAD:
    """Silero v5 wrapper with independent recurrent state for each speaker."""

    def __init__(self, model_path: Path):
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.states: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    def reset(self, speaker: str) -> None:
        self.states[speaker] = (
            np.zeros((2, 1, 128), dtype=np.float32),
            np.zeros((1, 64), dtype=np.float32),
        )

    def score(self, speaker: str, frame: np.ndarray) -> float:
        if speaker not in self.states:
            self.reset(speaker)
        state, context = self.states[speaker]
        audio = np.concatenate([context, frame[None, :]], axis=1).astype(np.float32)
        output, state = self.session.run(None, {
            "input": audio,
            "state": state,
            "sr": np.array(SAMPLE_RATE, dtype=np.int64),
        })
        self.states[speaker] = (state, audio[:, -64:])
        return float(output[0][0])


class TurnScorer:
    """Smart Turn v3.2 GPU wrapper using start-padding from the benchmark."""

    def __init__(self):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor

        model_path = hf_hub_download("pipecat-ai/smart-turn-v3", "smart-turn-v3.2-gpu.onnx")
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            model_path, sess_options=options, providers=["CUDAExecutionProvider"]
        )
        self.feature_extractor = WhisperFeatureExtractor(chunk_length=8)

    def score(self, audio: np.ndarray) -> float:
        audio = audio[-8 * SAMPLE_RATE:]
        if len(audio) < 8 * SAMPLE_RATE:
            audio = np.pad(audio, (8 * SAMPLE_RATE - len(audio), 0))
        features = self.feature_extractor(
            audio,
            sampling_rate=SAMPLE_RATE,
            return_tensors="np",
            padding="max_length",
            max_length=8 * SAMPLE_RATE,
            truncation=True,
            do_normalize=True,
        ).input_features.astype(np.float32)
        return float(self.session.run(None, {"input_features": features})[0][0].item())


class ParakeetSTT:
    """Parakeet TDT 0.6B v2 transcription on CUDA."""

    def __init__(self):
        import onnx_asr
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self.model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v2",
            sess_options=options,
            providers=[("CUDAExecutionProvider", {
                "gpu_mem_limit": str(PARAKEET_GPU_MEM_LIMIT),
                "arena_extend_strategy": "kSameAsRequested",
            })],
        )

    def transcribe(self, audio: np.ndarray) -> str:
        return str(self.model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()


def _sentences(text: str) -> list[str]:
    """Split a reply into speakable chunks while preserving punctuation."""
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text.strip()) if part.strip()]


def _to_discord_pcm(samples: np.ndarray, sample_rate: int) -> bytes:
    """Convert Kokoro float mono audio to 48 kHz stereo signed 16-bit PCM."""
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if sample_rate != OUTPUT_RATE and len(samples):
        output_count = round(len(samples) * OUTPUT_RATE / sample_rate)
        source_x = np.arange(len(samples), dtype=np.float64)
        output_x = np.arange(output_count, dtype=np.float64) * sample_rate / OUTPUT_RATE
        samples = np.interp(output_x, source_x, samples).astype(np.float32)
    mono = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    return np.repeat(mono[:, None], 2, axis=1).reshape(-1).tobytes()


class KokoroTTS:
    """Lazy Kokoro GPU adapter. One sentence is generated at a time."""

    def __init__(self, models: Path):
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        session = ort.InferenceSession(
            str(models / "kokoro-v1.0.onnx"),
            sess_options=options,
            providers=["CUDAExecutionProvider"],
        )
        self.kokoro = Kokoro.from_session(session, str(models / "voices-v1.0.bin"))
        self.lock = threading.Lock()

    def stream(self, text: str, stopped: threading.Event):
        """Yield PCM chunks; use a private asyncio loop like the TTS benchmark."""
        import asyncio

        loop = asyncio.new_event_loop()
        try:
            for sentence in _sentences(text):
                if stopped.is_set():
                    break

                async def generate():
                    async for samples, sample_rate in self.kokoro.create_stream(
                        sentence, voice="af_heart", lang="en-us"
                    ):
                        yield samples, sample_rate

                generator = generate()
                try:
                    while not stopped.is_set():
                        try:
                            samples, sample_rate = loop.run_until_complete(generator.__anext__())
                        except StopAsyncIteration:
                            break
                        if not stopped.is_set():
                            yield _to_discord_pcm(samples, sample_rate)
                finally:
                    loop.run_until_complete(generator.aclose())
        finally:
            loop.close()


class SpeechWorker:
    """Owns listening and cancellable, per-reply speech generation."""

    def __init__(self, pipeline: SpeechPipeline, tts, emit: Callable[[dict], None]):
        self.pipeline = pipeline
        self.tts = tts
        self.emit = emit
        self.active: dict[str, threading.Event] = {}
        self.lock = threading.Lock()
        self.emit_lock = threading.Lock()

    def _emit(self, event: dict) -> None:
        # stdout is shared by the input thread and TTS threads; keep JSONL atomic.
        with self.emit_lock:
            self.emit(event)

    def say(self, identifier: str, text: str) -> None:
        identifier = str(identifier)
        stopped = threading.Event()
        with self.lock:
            previous = self.active.get(identifier)
            if previous is not None:
                previous.set()
            self.active[identifier] = stopped

        def run() -> None:
            try:
                # Kokoro's ONNX session is shared; serialize work across replies.
                with self.tts.lock:
                    for pcm in self.tts.stream(text, stopped):
                        if stopped.is_set():
                            break
                        self._emit({
                            "ev": "audio_out", "id": identifier,
                            "pcm": base64.b64encode(pcm).decode("ascii"),
                        })
            except Exception as error:
                print(f"speech worker TTS error ({identifier}): {error}", file=sys.stderr, flush=True)
            finally:
                self._emit({"ev": "say_done", "id": identifier})
                with self.lock:
                    if self.active.get(identifier) is stopped:
                        del self.active[identifier]

        threading.Thread(target=run, name=f"jester-tts-{identifier}", daemon=True).start()

    def cancel(self, identifier: str) -> None:
        with self.lock:
            stopped = self.active.get(str(identifier))
            if stopped is not None:
                stopped.set()


@dataclass
class SpeakerState:
    pcm_bytes: bytearray = field(default_factory=bytearray)
    audio: list[np.ndarray] = field(default_factory=list)
    speaking: bool = False
    silence_frames: int = 0
    silence_started: float | None = None
    pause_checked: bool = False
    last_prob: float = 0.0
    last_text: str = ""

    def clear_turn(self) -> None:
        self.pcm_bytes.clear()
        self.audio.clear()
        self.speaking = False
        self.silence_frames = 0
        self.silence_started = None
        self.pause_checked = False
        self.last_prob = 0.0
        self.last_text = ""


class SpeechPipeline:
    """Per-speaker streaming state machine, with model dependencies injectable."""

    def __init__(self, vad, turn_scorer, stt, emit: Callable[[dict], None], clock=time.monotonic):
        self.vad = vad
        self.turn_scorer = turn_scorer
        self.stt = stt
        self.emit = emit
        self.clock = clock
        self.speakers: dict[str, SpeakerState] = {}

    def reset(self, speaker: str) -> None:
        self.speakers.pop(str(speaker), None)
        self.vad.reset(str(speaker))

    @staticmethod
    def _audio(state: SpeakerState) -> np.ndarray:
        if not state.audio:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(state.audio)

    def feed(self, speaker: str, pcm: bytes) -> None:
        speaker = str(speaker)
        state = self.speakers.setdefault(speaker, SpeakerState())
        state.pcm_bytes.extend(pcm)
        while len(state.pcm_bytes) >= FRAME_BYTES:
            frame_bytes = bytes(state.pcm_bytes[:FRAME_BYTES])
            del state.pcm_bytes[:FRAME_BYTES]
            frame = np.frombuffer(frame_bytes, dtype="<i2").astype(np.float32) / 32768.0
            now = self.clock()
            probability = self.vad.score(speaker, frame)

            if not state.speaking:
                if probability >= VAD_START_THRESHOLD:
                    state.speaking = True
                    state.audio = [frame]
                    state.silence_frames = 0
                    state.silence_started = None
                    state.pause_checked = False
                    self.emit({"ev": "speech_start", "speaker": speaker})
                continue

            state.audio.append(frame)
            if len(state.audio) > MAX_UTTERANCE_FRAMES:
                del state.audio[:len(state.audio) - MAX_UTTERANCE_FRAMES]
            if probability >= VAD_START_THRESHOLD:
                state.silence_frames = 0
                state.silence_started = None
                state.pause_checked = False
                continue
            if probability < VAD_CONTINUE_THRESHOLD:
                state.silence_frames += 1
                if state.silence_started is None:
                    state.silence_started = now - (state.silence_frames - 1) * FRAME_SAMPLES / SAMPLE_RATE
            else:
                state.silence_frames = 0
                state.silence_started = None
                state.pause_checked = False

            if (not state.pause_checked and
                    state.silence_frames * FRAME_SAMPLES * 1000 / SAMPLE_RATE >= PAUSE_MS):
                state.pause_checked = True
                self._evaluate_pause(speaker, state, now)

    def _evaluate_pause(self, speaker: str, state: SpeakerState, now: float) -> None:
        audio = self._audio(state)
        stt_started = time.perf_counter()
        state.last_text = self.stt.transcribe(audio)
        stt_ms = round((time.perf_counter() - stt_started) * 1000)
        turn_started = time.perf_counter()
        state.last_prob = self.turn_scorer.score(audio)
        turn_ms = round((time.perf_counter() - turn_started) * 1000)
        self.emit({"ev": "pause", "speaker": speaker, "prob": state.last_prob, "text": state.last_text,
                   "ms": {"stt": stt_ms, "smart_turn": turn_ms}})
        silence_ms = max(0.0, (now - state.silence_started) * 1000) if state.silence_started is not None else 0.0
        last_word = state.last_text.lower().strip().split()[-1].strip(".,!?;:'\"()[]{}") if state.last_text.strip() else ""
        timeout_ms = CONNECTOR_TIMEOUT_MS if state.last_prob < 0.05 and last_word in CONNECTORS else NORMAL_TIMEOUT_MS
        if state.last_prob > TURN_THRESHOLD or silence_ms >= timeout_ms:
            self._finish(speaker, state, now)

    def _finish(self, speaker: str, state: SpeakerState, now: float) -> None:
        text = state.last_text
        duration_ms = round(len(self._audio(state)) * 1000 / SAMPLE_RATE)
        self.emit({"ev": "turn_end", "speaker": speaker, "text": text, "ms": {"utterance": duration_ms}})
        state.clear_turn()

    def check_timeouts(self) -> None:
        """Advance silence fallbacks during input gaps, without requiring dummy frames."""
        now = self.clock()
        for speaker, state in list(self.speakers.items()):
            if not state.speaking or state.silence_started is None or not state.last_text:
                continue
            silence_ms = (now - state.silence_started) * 1000
            last_word = state.last_text.lower().strip().split()[-1].strip(".,!?;:'\"()[]{}")
            timeout_ms = CONNECTOR_TIMEOUT_MS if state.last_prob < 0.05 and last_word in CONNECTORS else NORMAL_TIMEOUT_MS
            if silence_ms >= timeout_ms:
                self._finish(speaker, state, now)


def _emit(event: dict) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


def main() -> None:
    add_nvidia_libs()
    models = _models_dir()
    for filename in ("silero_vad.onnx",):
        path = models / filename
        if not path.is_file():
            raise FileNotFoundError(f"required Jester model is missing: {path}")
    for filename in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        path = models / filename
        if not path.is_file():
            raise FileNotFoundError(f"required Jester model is missing: {path}")
    vad = SileroVAD(models / "silero_vad.onnx")
    pipeline = SpeechPipeline(vad, TurnScorer(), ParakeetSTT(), _emit)
    speech = SpeechWorker(pipeline, KokoroTTS(models), _emit)
    print(f"Jester speech models ready; Parakeet GPU arena cap={PARAKEET_GPU_MEM_LIMIT} bytes; "
          f"{_vram_usage()} after model load (startup peak snapshot)", file=sys.stderr, flush=True)
    _emit({"ev": "ready"})
    for line in sys.stdin:
        try:
            message = json.loads(line)
            operation = message.get("op")
            if operation == "ping":
                _emit({"ev": "pong", "id": str(message.get("id", ""))})
            elif operation == "say":
                identifier = str(message.get("id", ""))
                if not identifier:
                    raise ValueError("id is required")
                speech.say(identifier, str(message.get("text", "")))
            elif operation == "cancel":
                identifier = str(message.get("id", ""))
                if not identifier:
                    raise ValueError("id is required")
                speech.cancel(identifier)
            elif operation in ("reset", "audio"):
                speaker = str(message.get("speaker", ""))
                if not speaker:
                    raise ValueError("speaker is required")
                if operation == "reset":
                    pipeline.reset(speaker)
                else:
                    pcm = base64.b64decode(message["pcm"], validate=True)
                    pipeline.feed(speaker, pcm)
                pipeline.check_timeouts()
            else:
                raise ValueError(f"unsupported operation: {operation!r}")
        except Exception as error:
            print(f"speech worker input error: {error}", file=sys.stderr, flush=True)


def _vram_usage() -> str:
    """Return a startup VRAM snapshot without making nvidia-smi a requirement."""
    import subprocess

    for command in ("/usr/lib/wsl/lib/nvidia-smi", "nvidia-smi"):
        try:
            result = subprocess.run(
                [command, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                check=True, capture_output=True, text=True, timeout=2,
            )
            return f"GPU memory used={result.stdout.strip().splitlines()[0]} MiB"
        except (OSError, subprocess.SubprocessError, IndexError):
            continue
    return "GPU memory snapshot unavailable"


if __name__ == "__main__":
    main()
