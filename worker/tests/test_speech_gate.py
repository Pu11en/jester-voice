"""Speech gate, sustained-voice, idle-timeout and metrics tests with fake models only."""

from __future__ import annotations

import base64
import json
import os
import wave

import numpy as np
import pytest

from worker.speech import (
    FRAME_SAMPLES,
    SAMPLE_RATE,
    SPEECH_START_FRAMES,
    SUSTAINED_MS,
    LineReader,
    SpeechPipeline,
    debug_clips_dir,
    serve,
    serve_step,
)

FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
FRAME_MS = round(FRAME_SECONDS * 1000)
PAUSE_FRAMES = 7  # 7 * 32 ms is the first frame count at or above PAUSE_MS (200 ms).


class FakeClock:
    def __init__(self) -> None:
        self.seconds = 0.0

    def __call__(self) -> float:
        return self.seconds

    def advance(self, seconds: float) -> None:
        self.seconds += seconds


class FakeVAD:
    """Score nonzero frames as voiced and advance the clock by one frame per call."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock

    def reset(self, _speaker: str) -> None:
        pass

    def score(self, _speaker: str, frame: np.ndarray) -> float:
        self.clock.advance(FRAME_SECONDS)
        return 0.9 if float(np.abs(frame).max()) > 0 else 0.0


class FakeTurnScorer:
    def __init__(self, probability: float) -> None:
        self.probability = probability

    def score(self, _audio: np.ndarray) -> float:
        return self.probability


class ScoredSTT:
    """An STT that exposes a mean token log-probability next to the text."""

    def __init__(self, text: str, logprob: float) -> None:
        self.text = text
        self.logprob = logprob

    def transcribe_scored(self, _audio: np.ndarray) -> tuple[str, float | None]:
        return self.text, self.logprob


class PlainSTT:
    """An STT that only returns text, like a model without token scores."""

    def transcribe(self, _audio: np.ndarray) -> str:
        return "hello there"


class FakeSource:
    """Queued input lines; once drained, each read waits out its timeout and returns None."""

    def __init__(self, clock: FakeClock, lines: list[str]) -> None:
        self.clock = clock
        self.lines = list(lines)

    def readline(self, timeout: float) -> str | None:
        if self.lines:
            return self.lines.pop(0)
        self.clock.advance(timeout)
        return None


def voiced(frames: int) -> bytes:
    return np.full(frames * FRAME_SAMPLES, 8192, dtype="<i2").tobytes()


def silence(frames: int) -> bytes:
    return np.zeros(frames * FRAME_SAMPLES, dtype="<i2").tobytes()


def audio_line(speaker: str, pcm: bytes) -> str:
    return json.dumps({"op": "audio", "speaker": speaker, "pcm": base64.b64encode(pcm).decode("ascii")})


def make_pipeline(events: list, clock: FakeClock, *, turn_probability: float = 0.9, stt=None, **kwargs):
    stt = ScoredSTT("hello there", -0.25) if stt is None else stt
    return SpeechPipeline(FakeVAD(clock), FakeTurnScorer(turn_probability), stt, events.append, clock, **kwargs)


def names(events: list) -> list[str]:
    return [event["ev"] for event in events]


def test_short_burst_followed_by_silence_produces_no_events():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())

    pipeline.feed("owner", voiced(5) + silence(20))
    pipeline.check_timeouts()

    assert events == []
    assert pipeline.speakers["owner"].audio == []


def test_speech_start_fires_on_the_ninth_voiced_frame_and_keeps_every_frame():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())
    first_frame = np.arange(FRAME_SAMPLES, dtype="<i2") + 1

    pipeline.feed("owner", first_frame.tobytes())
    for _ in range(SPEECH_START_FRAMES - 2):
        pipeline.feed("owner", voiced(1))
    assert events == []

    pipeline.feed("owner", voiced(1))
    assert events == [{"ev": "speech_start", "speaker": "owner"}]
    state = pipeline.speakers["owner"]
    assert len(state.audio) == SPEECH_START_FRAMES == 9
    assert np.array_equal(state.audio[0], first_frame.astype(np.float32) / 32768.0)


def test_brief_dip_before_start_keeps_the_onset_audio():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())

    pipeline.feed("owner", voiced(2) + silence(1) + voiced(SPEECH_START_FRAMES))

    assert names(events) == ["speech_start"]
    assert len(pipeline.speakers["owner"].audio) == SPEECH_START_FRAMES + 3


def test_discarding_a_burst_keeps_the_rest_of_the_same_chunk():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())

    pipeline.feed("owner", voiced(5) + silence(6) + voiced(SPEECH_START_FRAMES))

    assert names(events) == ["speech_start"]
    assert len(pipeline.speakers["owner"].audio) == SPEECH_START_FRAMES


def test_pending_burst_is_discarded_after_an_idle_gap():
    events: list = []
    clock = FakeClock()
    pipeline = make_pipeline(events, clock)

    pipeline.feed("owner", voiced(5))
    assert len(pipeline.speakers["owner"].audio) == 5
    clock.advance(0.3)
    pipeline.check_timeouts()

    assert events == []
    assert pipeline.speakers["owner"].audio == []


def test_sustained_voice_is_reported_once_per_utterance():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())
    sustained_frames = -(-SUSTAINED_MS // FRAME_MS)  # 32 frames = 1024 ms

    for _ in range(sustained_frames - 1):
        pipeline.feed("owner", voiced(1))
    assert names(events) == ["speech_start"]

    pipeline.feed("owner", voiced(1))
    assert names(events) == ["speech_start", "speech_sustained"]
    assert events[-1] == {"ev": "speech_sustained", "speaker": "owner", "voiced_ms": sustained_frames * FRAME_MS}

    pipeline.feed("owner", voiced(20))
    assert names(events) == ["speech_start", "speech_sustained"]


def test_low_confidence_turn_ends_from_idle_serve_steps_without_audio():
    events: list = []
    clock = FakeClock()
    pipeline = make_pipeline(events, clock, turn_probability=0.1)
    source = FakeSource(clock, [audio_line("owner", voiced(12) + silence(PAUSE_FRAMES))])

    assert serve_step(source, pipeline, None, events.append, timeout_s=0.5) is True
    assert names(events) == ["speech_start", "pause"]
    assert events[-1]["prob"] == 0.1
    assert events[-1]["text"] == "hello there"

    for _ in range(3):  # 1.5 s idle: still inside NORMAL_TIMEOUT_MS
        assert serve_step(source, pipeline, None, events.append, timeout_s=0.5) is True
    assert "turn_end" not in names(events)

    assert serve_step(source, pipeline, None, events.append, timeout_s=0.5) is True  # 2.0 s idle
    ends = [event for event in events if event["ev"] == "turn_end"]
    assert len(ends) == 1
    assert ends[0]["text"] == "hello there"
    assert pipeline.speakers["owner"].speaking is False


def test_turn_is_evaluated_when_frames_stop_before_the_pause_check():
    events: list = []
    clock = FakeClock()
    pipeline = make_pipeline(events, clock)

    pipeline.feed("owner", voiced(12) + silence(2))
    pipeline.check_timeouts()
    assert names(events) == ["speech_start"]

    clock.advance(0.3)
    pipeline.check_timeouts()
    assert names(events) == ["speech_start", "pause", "turn_end"]


def test_serve_step_returns_false_at_end_of_input():
    events: list = []
    clock = FakeClock()
    pipeline = make_pipeline(events, clock)

    class Eof:
        def readline(self, _timeout: float) -> str:
            return ""

    assert serve_step(Eof(), pipeline, None, events.append, timeout_s=0.5) is False


def test_pause_and_turn_end_carry_voiced_ms_vad_mean_and_stt_logprob(capsys):
    events: list = []
    pipeline = make_pipeline(events, FakeClock())

    pipeline.feed("owner", voiced(12) + silence(PAUSE_FRAMES))

    assert names(events) == ["speech_start", "pause", "turn_end"]
    pause, end = events[1], events[2]
    for event in (pause, end):
        assert event["voiced_ms"] == 12 * FRAME_MS
        assert event["vad_mean"] == pytest.approx(12 * 0.9 / (12 + PAUSE_FRAMES), abs=0.001)
        assert event["stt_logprob"] == -0.25
    assert end["ms"]["utterance"] == (12 + PAUSE_FRAMES) * FRAME_MS
    assert end["text"] == "hello there"
    assert json.dumps(end)
    debug_lines = [line for line in capsys.readouterr().err.splitlines() if "turn_end" in line]
    assert len(debug_lines) == 1
    assert "voiced_ms=384" in debug_lines[0]


def test_stt_logprob_is_null_when_the_stt_exposes_no_scores():
    events: list = []
    pipeline = make_pipeline(events, FakeClock(), stt=PlainSTT())

    pipeline.feed("owner", voiced(12) + silence(PAUSE_FRAMES))

    end = events[-1]
    assert end["ev"] == "turn_end"
    assert end["text"] == "hello there"
    assert end["stt_logprob"] is None
    assert '"stt_logprob":null' in json.dumps(end, separators=(",", ":"))


def test_debug_clips_are_written_only_when_the_env_dir_is_set(tmp_path, monkeypatch):
    monkeypatch.delenv("JESTER_DEBUG_CLIPS_DIR", raising=False)
    assert debug_clips_dir() is None
    events: list = []
    pipeline = make_pipeline(events, FakeClock(), clips_dir=debug_clips_dir())
    pipeline.feed("owner", voiced(12) + silence(PAUSE_FRAMES))
    assert names(events)[-1] == "turn_end"
    assert list(tmp_path.iterdir()) == []

    clips_dir = tmp_path / "debug-clips"
    monkeypatch.setenv("JESTER_DEBUG_CLIPS_DIR", str(clips_dir))
    assert debug_clips_dir() == clips_dir
    events.clear()
    pipeline = make_pipeline(events, FakeClock(), clips_dir=debug_clips_dir())
    pipeline.feed("owner", voiced(12) + silence(PAUSE_FRAMES))
    assert names(events)[-1] == "turn_end"

    clips = sorted(clips_dir.glob("*.wav"))
    assert len(clips) == 1
    with wave.open(str(clips[0]), "rb") as clip:
        assert (clip.getnchannels(), clip.getsampwidth(), clip.getframerate()) == (1, 2, SAMPLE_RATE)
        assert clip.getnframes() == (12 + PAUSE_FRAMES) * FRAME_SAMPLES
        samples = np.frombuffer(clip.readframes(FRAME_SAMPLES), dtype="<i2")
    assert int(samples[0]) == 8192


def test_serve_drains_a_pipe_and_stops_at_end_of_input():
    events: list = []
    pipeline = make_pipeline(events, FakeClock())
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, (audio_line("owner", voiced(12)) + "\n" + audio_line("owner", silence(PAUSE_FRAMES)) + "\n"
                            + json.dumps({"op": "ping", "id": "hb-1"}) + "\n").encode())
        os.close(write_fd)
        write_fd = None
        serve(LineReader(read_fd), pipeline, None, events.append, timeout_s=0.01)
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)

    assert names(events) == ["speech_start", "pause", "turn_end", "pong"]
    assert events[-1] == {"ev": "pong", "id": "hb-1"}


def test_line_reader_returns_buffered_lines_before_polling_again():
    read_fd, write_fd = os.pipe()
    try:
        reader = LineReader(read_fd)
        os.write(write_fd, b'{"op":"a"}\n{"op":"b"}\n')
        assert reader.readline(0.05) == '{"op":"a"}'
        assert reader.readline(0.0) == '{"op":"b"}'
        assert reader.readline(0.01) is None
        os.write(write_fd, b"partial")
        assert reader.readline(0.01) is None
        os.close(write_fd)
        write_fd = None
        assert reader.readline(0.05) == "partial"
        assert reader.readline(0.05) == ""
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
