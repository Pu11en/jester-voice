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
import select
import site
import sys
import threading
import time
import re
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512  # Silero v5's 32 ms frame at 16 kHz.
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_MS = FRAME_SAMPLES * 1000 / SAMPLE_RATE
MAX_UTTERANCE_FRAMES = 60 * SAMPLE_RATE // FRAME_SAMPLES
VAD_START_THRESHOLD = 0.5
VAD_CONTINUE_THRESHOLD = 0.35
# speech_start needs this many consecutive voiced frames (~288 ms), so clicks,
# breaths and short coughs never start a turn. The frames are buffered meanwhile.
SPEECH_START_FRAMES = 9
# A pending burst is dropped once this many silent frames (~192 ms) follow it.
SPEECH_START_GAP_FRAMES = 6
# speech_sustained is emitted once an utterance holds this much voiced audio.
SUSTAINED_MS = 1_000
PAUSE_MS = 200
INPUT_POLL_MS = 100  # Idle stdin poll, so silence fallbacks run without new audio.
TURN_THRESHOLD = 0.5
NORMAL_TIMEOUT_MS = 1_800
CONNECTOR_TIMEOUT_MS = 7_000
CONNECTORS = {"to", "the", "and", "with", "of", "um", "uh", "like", "so", "but", "or", "because"}
OUTPUT_RATE = 48_000
PARAKEET_GPU_MEM_LIMIT = int(os.environ.get("JESTER_PARAKEET_GPU_MEM_LIMIT", str(4 * 1024**3)))


def _models_dir() -> Path:
    return Path(os.environ.get(
        "JESTER_MODELS_DIR", "/home/drewp/main-projects/jester-voice/bench/data/models"
    ))


def debug_clips_dir() -> Path | None:
    """Opt-in folder for finished utterances as 16 kHz wav files (JESTER_DEBUG_CLIPS_DIR)."""
    value = os.environ.get("JESTER_DEBUG_CLIPS_DIR", "").strip()
    return Path(value) if value else None


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
        # The same decoder, asked to keep per-token log-probabilities.
        self.scored_model = self.model.with_timestamps()
        self.scored_failed = False

    def transcribe(self, audio: np.ndarray) -> str:
        return str(self.model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()

    def transcribe_scored(self, audio: np.ndarray) -> tuple[str, float | None]:
        """Transcribe and return the mean token log-probability, or None without tokens."""
        if not self.scored_failed:
            try:
                result = self.scored_model.recognize(audio, sample_rate=SAMPLE_RATE)
                logprobs = list(result.logprobs or [])
                return str(result.text).strip(), (float(np.mean(logprobs)) if logprobs else None)
            except Exception as error:  # noqa: BLE001 - reported once; plain transcription continues
                self.scored_failed = True
                print(f"speech worker STT log-probability path failed; continuing without it: "
                      f"{error}", file=sys.stderr, flush=True)
        return self.transcribe(audio), None


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
        self.threads: set[threading.Thread] = set()
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
                    self.threads.discard(threading.current_thread())

        thread = threading.Thread(target=run, name=f"jester-tts-{identifier}", daemon=True)
        with self.lock:
            self.threads.add(thread)
        thread.start()

    def cancel(self, identifier: str) -> None:
        with self.lock:
            stopped = self.active.get(str(identifier))
            if stopped is not None:
                stopped.set()

    def close(self) -> None:
        with self.lock:
            for stopped in self.active.values():
                stopped.set()
            threads = list(self.threads)
        for thread in threads:
            thread.join(timeout=10)


@dataclass
class SpeakerState:
    pcm_bytes: bytearray = field(default_factory=bytearray)
    audio: list[np.ndarray] = field(default_factory=list)
    speaking: bool = False
    start_run: int = 0  # Consecutive voiced frames while waiting for speech_start.
    start_gap: int = 0  # Silent frames since the last voiced frame while waiting.
    last_frame_at: float = 0.0
    silence_frames: int = 0
    silence_started: float | None = None
    pause_checked: bool = False
    last_prob: float = 0.0
    last_text: str = ""
    last_logprob: float | None = None
    clipped: bool = False
    voiced_frames: int = 0
    vad_sum: float = 0.0
    vad_frames: int = 0
    sustained_sent: bool = False

    @property
    def voiced_ms(self) -> int:
        return round(self.voiced_frames * FRAME_MS)

    def clear_turn(self) -> None:
        # pcm_bytes is the frame remainder of the input stream, not part of the turn;
        # clearing it here would drop the rest of a chunk still being fed.
        self.audio.clear()
        self.speaking = False
        self.start_run = 0
        self.start_gap = 0
        self.silence_frames = 0
        self.silence_started = None
        self.pause_checked = False
        self.last_prob = 0.0
        self.last_text = ""
        self.last_logprob = None
        self.clipped = False
        self.voiced_frames = 0
        self.vad_sum = 0.0
        self.vad_frames = 0
        self.sustained_sent = False


class SpeechPipeline:
    """Per-speaker streaming state machine, with model dependencies injectable."""

    def __init__(self, vad, turn_scorer, stt, emit: Callable[[dict], None], clock=time.monotonic,
                 clips_dir: Path | None = None):
        self.vad = vad
        self.turn_scorer = turn_scorer
        self.stt = stt
        self.emit = emit
        self.clock = clock
        self.clips_dir = clips_dir
        self.clip_count = 0
        self.speakers: dict[str, SpeakerState] = {}

    def reset(self, speaker: str) -> None:
        self.speakers.pop(str(speaker), None)
        self.vad.reset(str(speaker))

    @staticmethod
    def _audio(state: SpeakerState) -> np.ndarray:
        if not state.audio:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(state.audio)

    @staticmethod
    def _append(state: SpeakerState, frame: np.ndarray, probability: float) -> None:
        state.audio.append(frame)
        if len(state.audio) > MAX_UTTERANCE_FRAMES:
            del state.audio[:len(state.audio) - MAX_UTTERANCE_FRAMES]
            state.clipped = True
        state.vad_sum += probability
        state.vad_frames += 1
        if probability >= VAD_START_THRESHOLD:
            state.voiced_frames += 1

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
            state.last_frame_at = now
            voiced = probability >= VAD_START_THRESHOLD

            if not state.speaking:
                if not voiced and not state.audio:
                    continue
                self._append(state, frame, probability)
                if voiced:
                    state.start_run += 1
                    state.start_gap = 0
                    if state.start_run >= SPEECH_START_FRAMES:
                        state.speaking = True
                        self.emit({"ev": "speech_start", "speaker": speaker})
                else:
                    # Keep a brief dip so a real onset is never lost, but drop a
                    # burst that ends before it can count as speech.
                    state.start_run = 0
                    state.start_gap += 1
                    if state.start_gap >= SPEECH_START_GAP_FRAMES:
                        state.clear_turn()
                continue

            self._append(state, frame, probability)
            if voiced:
                state.silence_frames = 0
                state.silence_started = None
                state.pause_checked = False
                if not state.sustained_sent and state.voiced_ms >= SUSTAINED_MS:
                    state.sustained_sent = True
                    self.emit({"ev": "speech_sustained", "speaker": speaker,
                               "voiced_ms": state.voiced_ms})
                continue
            if probability < VAD_CONTINUE_THRESHOLD:
                state.silence_frames += 1
                if state.silence_started is None:
                    state.silence_started = now - (state.silence_frames - 1) * FRAME_SAMPLES / SAMPLE_RATE
            else:
                state.silence_frames = 0
                state.silence_started = None
                state.pause_checked = False

            if not state.pause_checked and state.silence_frames * FRAME_MS >= PAUSE_MS:
                state.pause_checked = True
                self._evaluate_pause(speaker, state, now)

    def _transcribe(self, audio: np.ndarray) -> tuple[str, float | None]:
        """Use the STT's scored transcription when it offers one; otherwise text only."""
        scored = getattr(self.stt, "transcribe_scored", None)
        if scored is not None:
            text, logprob = scored(audio)
            return str(text).strip(), (None if logprob is None else float(logprob))
        return str(self.stt.transcribe(audio)).strip(), None

    @staticmethod
    def _metrics(state: SpeakerState) -> dict:
        vad_mean = state.vad_sum / state.vad_frames if state.vad_frames else 0.0
        logprob = None if state.last_logprob is None else round(state.last_logprob, 4)
        return {"voiced_ms": state.voiced_ms, "vad_mean": round(vad_mean, 3), "stt_logprob": logprob}

    @staticmethod
    def _timeout_ms(state: SpeakerState) -> int:
        words = state.last_text.lower().split()
        last_word = words[-1].strip(".,!?;:'\"()[]{}") if words else ""
        if state.last_prob < 0.05 and last_word in CONNECTORS:
            return CONNECTOR_TIMEOUT_MS
        return NORMAL_TIMEOUT_MS

    def _evaluate_pause(self, speaker: str, state: SpeakerState, now: float) -> None:
        audio = self._audio(state)
        stt_started = time.perf_counter()
        state.last_text, state.last_logprob = self._transcribe(audio)
        stt_ms = round((time.perf_counter() - stt_started) * 1000)
        turn_started = time.perf_counter()
        state.last_prob = self.turn_scorer.score(audio)
        turn_ms = round((time.perf_counter() - turn_started) * 1000)
        self.emit({"ev": "pause", "speaker": speaker, "prob": state.last_prob, "text": state.last_text,
                   "incomplete": state.clipped,
                   "ms": {"stt": stt_ms, "smart_turn": turn_ms}, **self._metrics(state)})
        silence_ms = max(0.0, (now - state.silence_started) * 1000) if state.silence_started is not None else 0.0
        if state.last_prob > TURN_THRESHOLD or silence_ms >= self._timeout_ms(state):
            self._finish(speaker, state, now)

    def _finish(self, speaker: str, state: SpeakerState, now: float) -> None:
        text = state.last_text
        audio = self._audio(state)
        duration_ms = round(len(audio) * 1000 / SAMPLE_RATE)
        metrics = self._metrics(state)
        self.emit({"ev": "turn_end", "speaker": speaker, "text": text,
                   "incomplete": state.clipped, "ms": {"utterance": duration_ms}, **metrics})
        clip = self._write_clip(speaker, audio)
        print(f"speech turn_end speaker={speaker} utterance_ms={duration_ms} "
              f"voiced_ms={metrics['voiced_ms']} vad_mean={metrics['vad_mean']} "
              f"stt_logprob={metrics['stt_logprob']} incomplete={state.clipped} "
              f"text={text[:120]!r}" + (f" clip={clip}" if clip else ""),
              file=sys.stderr, flush=True)
        state.clear_turn()

    def _write_clip(self, speaker: str, audio: np.ndarray) -> Path | None:
        """Save the finished utterance as a 16 kHz mono wav when clip capture is enabled."""
        if self.clips_dir is None or not len(audio):
            return None
        self.clip_count += 1
        stamp = time.strftime("%Y%m%dT%H%M%S")
        safe_speaker = re.sub(r"[^A-Za-z0-9_-]", "_", speaker)[:32] or "speaker"
        path = self.clips_dir / f"{stamp}-{self.clip_count:04d}-{safe_speaker}.wav"
        try:
            self.clips_dir.mkdir(parents=True, exist_ok=True)
            with wave.open(str(path), "wb") as clip:
                clip.setnchannels(1)
                clip.setsampwidth(2)
                clip.setframerate(SAMPLE_RATE)
                # Exact inverse of the int16 / 32768 decode in feed().
                samples = np.clip(np.round(audio * 32768.0), -32768, 32767).astype("<i2")
                clip.writeframes(samples.tobytes())
        except OSError as error:
            print(f"speech worker clip write failed ({path}): {error}", file=sys.stderr, flush=True)
            return None
        return path

    def check_timeouts(self) -> None:
        """Advance silence fallbacks during input gaps, without requiring dummy frames.

        Discord stops delivering frames shortly after the owner goes quiet, so the
        time since the last frame counts as silence here: it can drop a short
        pending burst, trigger the pause evaluation, and end a low-confidence turn.
        """
        now = self.clock()
        for speaker, state in list(self.speakers.items()):
            gap_ms = (now - state.last_frame_at) * 1000
            if not state.speaking:
                if state.audio and gap_ms >= PAUSE_MS:
                    state.clear_turn()
                continue
            if not state.pause_checked:
                silence_since = state.last_frame_at if state.silence_started is None else state.silence_started
                if (now - silence_since) * 1000 < PAUSE_MS:
                    continue
                state.silence_started = silence_since
                state.pause_checked = True
                self._evaluate_pause(speaker, state, now)
                continue
            if state.silence_started is None:
                continue
            if (now - state.silence_started) * 1000 >= self._timeout_ms(state):
                self._finish(speaker, state, now)


def _emit(event: dict) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


class LineSource(Protocol):
    def readline(self, timeout: float) -> str | None:
        """Return the next line without its newline, "" at end of input, None on timeout."""


class LineReader:
    """Newline-delimited reader over a file descriptor with a poll timeout.

    It reads the descriptor directly, so a line already buffered here is returned
    without waiting for more input (a TextIOWrapper's buffer would be invisible
    to select and could hold a message until the next audio frame arrived).
    """

    def __init__(self, fd: int, chunk_size: int = 1 << 16):
        self.fd = fd
        self.chunk_size = chunk_size
        self.buffer = bytearray()
        self.eof = False

    def readline(self, timeout: float) -> str | None:
        while True:
            index = self.buffer.find(b"\n")
            if index >= 0:
                line = bytes(self.buffer[:index])
                del self.buffer[:index + 1]
                return line.decode("utf-8", errors="replace")
            if self.eof:
                if not self.buffer:
                    return ""
                line = bytes(self.buffer)
                self.buffer.clear()
                return line.decode("utf-8", errors="replace")
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                return None
            chunk = os.read(self.fd, self.chunk_size)
            if not chunk:
                self.eof = True
            self.buffer.extend(chunk)


def handle_message(line: str, pipeline: SpeechPipeline, speech: SpeechWorker | None,
                   emit: Callable[[dict], None]) -> None:
    """Apply one JSON control line; input errors are reported, not raised."""
    if not line.strip():
        return
    operation = None
    try:
        message = json.loads(line)
        operation = message.get("op")
        if operation == "ping":
            emit({"ev": "pong", "id": str(message.get("id", ""))})
        elif operation in ("say", "cancel"):
            identifier = str(message.get("id", ""))
            if not identifier:
                raise ValueError("id is required")
            if speech is None:
                raise ValueError("speech output is unavailable")
            if operation == "say":
                speech.say(identifier, str(message.get("text", "")))
            else:
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
        if operation == "audio" and "Available memory" in str(error):
            # ONNX's CUDA arena is exhausted. The current utterance cannot
            # recover in place; let WorkerClient restart the model process
            # instead of silently failing on every later utterance.
            raise SystemExit(2) from error


def serve_step(source: LineSource, pipeline: SpeechPipeline, speech: SpeechWorker | None,
               emit: Callable[[dict], None], timeout_s: float = INPUT_POLL_MS / 1000) -> bool:
    """Handle one input line, or one idle poll timeout; return False at end of input."""
    line = source.readline(timeout_s)
    if line is None:
        pipeline.check_timeouts()
        return True
    if line == "":
        return False
    handle_message(line, pipeline, speech, emit)
    return True


def serve(source: LineSource, pipeline: SpeechPipeline, speech: SpeechWorker | None,
          emit: Callable[[dict], None], timeout_s: float = INPUT_POLL_MS / 1000) -> None:
    while serve_step(source, pipeline, speech, emit, timeout_s):
        pass


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
    clips_dir = debug_clips_dir()
    pipeline = SpeechPipeline(vad, TurnScorer(), ParakeetSTT(), _emit, clips_dir=clips_dir)
    speech = SpeechWorker(pipeline, KokoroTTS(models), _emit)
    print(f"Jester speech models ready; Parakeet GPU arena cap={PARAKEET_GPU_MEM_LIMIT} bytes; "
          f"{_vram_usage()} after model load (startup peak snapshot)", file=sys.stderr, flush=True)
    if clips_dir is not None:
        print(f"Jester debug clips enabled: {clips_dir}", file=sys.stderr, flush=True)
    _emit({"ev": "ready"})
    serve(LineReader(sys.stdin.fileno()), pipeline, speech, _emit)
    speech.close()


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
