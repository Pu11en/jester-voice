"""STT benchmark: latency, real-time factor, WER and VRAM per engine.

Usage: .venv/bin/python bench_stt.py <engine> [--clips data/clips.json] [--limit N]
Engines: fw-small-en-gpu, fw-small-en-cpu, fw-turbo-gpu, parakeet-v2-gpu, parakeet-v2-cpu
Appends one JSON line per run to results/stt.jsonl.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)


def add_nvidia_libs():
    # pip-installed CUDA/cuDNN wheels are not on the loader path by default.
    import site
    import ctypes
    import glob
    for sp in site.getsitepackages():
        for lib in sorted(glob.glob(os.path.join(sp, "nvidia", "*", "lib", "*.so*"))):
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass


class VramSampler:
    def __init__(self):
        self.peak = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            try:
                out = subprocess.check_output(
                    ["/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=memory.used",
                     "--format=csv,noheader,nounits"], text=True)
                self.peak = max(self.peak, int(out.strip().splitlines()[0]))
            except Exception:
                pass
            self._stop.wait(0.2)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()


def normalize(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    # LibriSpeech spells out titles; don't count "mr" vs "mister" as an error.
    words = [{"mr": "mister", "mrs": "missus", "dr": "doctor"}.get(w, w) for w in s.split()]
    return " ".join(words)


def load_engine(name):
    if name.startswith("fw-"):
        from faster_whisper import WhisperModel
        model_id = {"fw-small-en-gpu": "small.en", "fw-small-en-cpu": "small.en",
                    "fw-turbo-gpu": "large-v3-turbo"}[name]
        if name.endswith("gpu"):
            m = WhisperModel(model_id, device="cuda", compute_type="float16")
        else:
            m = WhisperModel(model_id, device="cpu", compute_type="int8", cpu_threads=4)

        def run(audio):
            segs, _ = m.transcribe(audio, beam_size=1, language="en",
                                   condition_on_previous_text=False, vad_filter=False)
            return " ".join(s.text for s in segs)
        return run
    if name.startswith("parakeet-v2-"):
        import onnx_asr
        prov = "CUDAExecutionProvider" if name.endswith("gpu") else "CPUExecutionProvider"
        m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", providers=[prov])

        def run(audio):
            return m.recognize(audio, sample_rate=16000)
        return run
    raise SystemExit(f"unknown engine {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("engine")
    ap.add_argument("--clips", default="data/clips.json")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    add_nvidia_libs()
    import jiwer

    clips = json.load(open(a.clips))
    if a.limit:
        clips = clips[: a.limit]
    audios = [sf.read(c["file"], dtype="float32")[0] for c in clips]

    with VramSampler() as vs:
        t0 = time.perf_counter()
        run = load_engine(a.engine)
        load_s = time.perf_counter() - t0
        run(audios[0])  # warm-up, not timed

        lat, hyps = [], []
        for audio in audios:
            t = time.perf_counter()
            hyps.append(run(audio))
            lat.append(time.perf_counter() - t)

    secs = [c["sec"] for c in clips]
    refs = [normalize(c["text"]) for c in clips]
    wer = jiwer.wer(refs, [normalize(h) for h in hyps])
    short = [l for l, s in zip(lat, secs) if s <= 5]
    res = {
        "engine": a.engine, "clips": len(clips), "audio_sec": round(sum(secs), 1),
        "load_sec": round(load_s, 1),
        "wer_pct": round(wer * 100, 2),
        "lat_mean_ms": round(1000 * float(np.mean(lat))),
        "lat_p90_ms": round(1000 * float(np.percentile(lat, 90))),
        "lat_short_clips_mean_ms": round(1000 * float(np.mean(short))) if short else None,
        "rtfx": round(sum(secs) / sum(lat), 1),
        "vram_peak_mb": vs.peak,
    }
    os.makedirs("results", exist_ok=True)
    with open("results/stt.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")
    print(json.dumps(res))
    for i in (0, 1):
        print("REF:", refs[i][:120], "\nHYP:", normalize(hyps[i])[:120], file=sys.stderr)


if __name__ == "__main__":
    main()
