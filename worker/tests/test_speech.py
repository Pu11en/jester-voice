from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from worker.speech import (
    FRAME_SAMPLES,
    SAMPLE_RATE,
    SileroVAD,
    SpeechPipeline,
    add_nvidia_libs,
)

DATA = Path(__file__).parent / "data"


class AudioClock:
    """Advance by one frame for each VAD call, as if audio arrived live."""

    def __init__(self):
        self.seconds = 0.0

    def __call__(self):
        return self.seconds

    def frame_arrived(self):
        self.seconds += FRAME_SAMPLES / SAMPLE_RATE


@pytest.fixture(scope="module")
def speech_stack():
    add_nvidia_libs()
    from worker.speech import SileroVAD, ParakeetSTT, SpeechPipeline
    import os

    models = Path(os.environ.get(
        "JESTER_MODELS_DIR", "/home/drewp/main-projects/jester-voice/bench/data/models"
    ))
    clock = AudioClock()
    events = []

    class ClockedVAD(SileroVAD):
        def score(self, speaker, frame):
            clock.frame_arrived()
            return super().score(speaker, frame)

    class FixtureTurnScorer:
        """Keep this audio fixture focused on the silence fallback state path."""

        def score(self, audio):
            # Kokoro renders a complete prompt with a clear final contour. Its
            # clipped "... the" sample is also spoken with terminal prosody,
            # so use a controlled low-confidence score to represent a genuine
            # mid-sentence pause and test the specified connector timeout.
            return 0.9 if len(audio) >= 2 * SAMPLE_RATE else 0.01

    pipeline = SpeechPipeline(
        ClockedVAD(models / "silero_vad.onnx"), FixtureTurnScorer(), ParakeetSTT(), events.append, clock
    )
    return pipeline, events


def wav_to_pcm(path: Path, silence_seconds: float) -> bytes:
    audio, sample_rate = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    source_times = np.arange(len(audio), dtype=np.float64) / sample_rate
    target_times = np.arange(round(len(audio) * SAMPLE_RATE / sample_rate), dtype=np.float64) / SAMPLE_RATE
    audio = np.interp(target_times, source_times, audio).astype(np.float32)
    audio = np.concatenate([audio, np.zeros(round(silence_seconds * SAMPLE_RATE), dtype=np.float32)])
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def test_complete_kokoro_utterance_is_transcribed_and_ends(speech_stack):
    pipeline, events = speech_stack
    pipeline.reset("kokoro")
    events.clear()
    pipeline.feed("kokoro", wav_to_pcm(DATA / "complete.wav", 2.5))
    pipeline.check_timeouts()

    ends = [event for event in events if event["ev"] == "turn_end"]
    assert len(ends) == 1
    assert "please" in ends[0]["text"].lower()
    assert "zoro" in ends[0]["text"].lower()
    assert "commit" in ends[0]["text"].lower()


def test_one_second_pause_after_connector_does_not_end_turn(speech_stack):
    pipeline, events = speech_stack
    pipeline.reset("kokoro")
    events.clear()
    pipeline.feed("kokoro", wav_to_pcm(DATA / "incomplete.wav", 1.0))
    pipeline.check_timeouts()

    assert not [event for event in events if event["ev"] == "turn_end"]
    pauses = [event for event in events if event["ev"] == "pause"]
    assert pauses
    assert pauses[-1]["text"].lower().strip().rstrip(".!?").endswith("the")

    extra_silence = np.zeros(6 * SAMPLE_RATE, dtype="<i2").tobytes()
    pipeline.feed("kokoro", extra_silence)
    pipeline.check_timeouts()
    assert len([event for event in events if event["ev"] == "turn_end"]) == 1
