"""TTS benchmark: time-to-first-audio, speed, cancel time, CPU/VRAM cost.

Kokoro runs in .venv (onnxruntime-gpu); Pocket TTS runs in .venv-pocket (CPU torch):
  .venv/bin/python        bench_tts.py kokoro-gpu  --voice af_heart
  .venv/bin/python        bench_tts.py kokoro-cpu  --voice af_heart
  .venv-pocket/bin/python bench_tts.py pocket-cpu  --voice alba
Appends to results/tts.jsonl and writes samples/<engine>-<voice>.wav.
"""
import argparse
import asyncio
import json
import os
import resource
import time

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

# Typical Jester replies: short, two sentences, spoken right after a turn ends.
REPLIES = [
    "Zoro's still on the login fix. He's about halfway through the tests, want me to check back when he's done?",
    "Got it. I started a new session for the Jester Voice repo and told it to look into Discord audio.",
    "Nami finished about ten minutes ago. Everything passed, so the checkout page is ready for you to try.",
    "Sure, stopping Sanji now.",
]


def cpu_s():
    r = resource.getrusage(resource.RUSAGE_SELF)
    return r.ru_utime + r.ru_stime


def kokoro_engine(device, voice):
    from bench_stt import add_nvidia_libs
    add_nvidia_libs()
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    prov = ["CUDAExecutionProvider"] if device == "gpu" else ["CPUExecutionProvider"]
    so = ort.SessionOptions()
    if device == "cpu":
        so.intra_op_num_threads = 2  # leave WSL's other threads for EBI
    sess = ort.InferenceSession("data/models/kokoro-v1.0.onnx", sess_options=so, providers=prov)
    k = Kokoro.from_session(sess, "data/models/voices-v1.0.bin")

    def stream(text, stop):
        async def agen():
            async for samples, sr in k.create_stream(text, voice=voice, lang="en-us"):
                yield samples, sr
        loop = asyncio.new_event_loop()
        g = agen()
        try:
            while not stop.is_set():
                try:
                    samples, sr = loop.run_until_complete(g.__anext__())
                except StopAsyncIteration:
                    break
                yield samples, sr
        finally:
            loop.run_until_complete(g.aclose())
            loop.close()
    return stream


def pocket_engine(voice):
    import torch
    from pocket_tts import TTSModel
    torch.set_num_threads(2)  # leave WSL's other threads for EBI
    m = TTSModel.load_model()
    state = m.get_state_for_audio_prompt(voice)
    sr = m.sample_rate

    def stream(text, stop):
        for chunk in m.generate_audio_stream(state, text, stop=stop):
            yield chunk.detach().float().numpy().reshape(-1), sr
    return stream


def vram_mb():
    import subprocess
    try:
        out = subprocess.check_output(["/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=memory.used",
                                       "--format=csv,noheader,nounits"], text=True)
        return int(out.strip().splitlines()[0])
    except Exception:
        return None


def main():
    import threading
    ap = argparse.ArgumentParser()
    ap.add_argument("engine", choices=["kokoro-gpu", "kokoro-cpu", "pocket-cpu"])
    ap.add_argument("--voice", required=True)
    a = ap.parse_args()

    t0 = time.perf_counter()
    stream = (kokoro_engine(a.engine.split("-")[1], a.voice) if a.engine.startswith("kokoro")
              else pocket_engine(a.voice))
    load_s = time.perf_counter() - t0
    for _ in stream("Warm up.", threading.Event()):
        pass

    ttfa, rtf, cpu_per_audio_s, sample = [], [], [], []
    for text in REPLIES:
        stop = threading.Event()
        t, c = time.perf_counter(), cpu_s()
        first, audio_s, chunks = None, 0.0, []
        for samples, sr in stream(text, stop):
            if first is None:
                first = time.perf_counter() - t
            audio_s += len(samples) / sr
            chunks.append(samples)
        wall = time.perf_counter() - t
        ttfa.append(first)
        rtf.append(audio_s / wall)
        cpu_per_audio_s.append((cpu_s() - c) / audio_s)
        sample.append(np.concatenate(chunks))
        sample.append(np.zeros(int(0.6 * sr), dtype=np.float32))

    # Cancel: stop right after the first chunk; how long until compute is freed?
    stop = threading.Event()
    g = stream(REPLIES[0] + " " + REPLIES[2], stop)
    next(g)
    t = time.perf_counter()
    stop.set()
    for _ in g:
        pass
    cancel_ms = (time.perf_counter() - t) * 1000

    os.makedirs("samples", exist_ok=True)
    wav = f"samples/{a.engine}-{a.voice}.wav"
    sf.write(wav, np.concatenate(sample), sr)
    res = {
        "engine": a.engine, "voice": a.voice, "load_sec": round(load_s, 1),
        "ttfa_ms_mean": round(1000 * float(np.mean(ttfa))),
        "ttfa_ms_max": round(1000 * float(np.max(ttfa))),
        "x_realtime": round(float(np.mean(rtf)), 1),
        "cpu_sec_per_audio_sec": round(float(np.mean(cpu_per_audio_s)), 2),
        "cancel_ms": round(cancel_ms),
        "vram_used_mb_after": vram_mb(),
        "max_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
        "sample": wav,
    }
    os.makedirs("results", exist_ok=True)
    with open("results/tts.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")
    print(json.dumps(res))


if __name__ == "__main__":
    main()
