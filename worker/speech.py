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
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512  # Silero v5's 32 ms frame at 16 kHz.
FRAME_BYTES = FRAME_SAMPLES * 2
VAD_START_THRESHOLD = 0.5
VAD_CONTINUE_THRESHOLD = 0.35
PAUSE_MS = 200
TURN_THRESHOLD = 0.5
NORMAL_TIMEOUT_MS = 1_800
CONNECTOR_TIMEOUT_MS = 7_000
CONNECTORS = {"to", "the", "and", "with", "of", "um", "uh", "like", "so", "but", "or", "because"}


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

        self.model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v2", providers=["CUDAExecutionProvider"]
        )

    def transcribe(self, audio: np.ndarray) -> str:
        return str(self.model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()


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
        state.last_text = self.stt.transcribe(audio)
        state.last_prob = self.turn_scorer.score(audio)
        self.emit({"ev": "pause", "speaker": speaker, "prob": state.last_prob, "text": state.last_text})
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
    vad = SileroVAD(models / "silero_vad.onnx")
    pipeline = SpeechPipeline(vad, TurnScorer(), ParakeetSTT(), _emit)
    for line in sys.stdin:
        try:
            message = json.loads(line)
            operation = message.get("op")
            speaker = str(message.get("speaker", ""))
            if not speaker:
                raise ValueError("speaker is required")
            if operation == "reset":
                pipeline.reset(speaker)
            elif operation == "audio":
                pcm = base64.b64decode(message["pcm"], validate=True)
                pipeline.feed(speaker, pcm)
            else:
                raise ValueError(f"unsupported operation: {operation!r}")
            pipeline.check_timeouts()
        except Exception as error:
            print(f"speech worker input error: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
