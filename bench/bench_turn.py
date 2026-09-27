"""End-of-turn benchmark: Silero VAD + Smart Turn v3.2 vs plain silence timeouts.

Builds two kinds of test turns from the LibriSpeech clips (word times from
faster-whisper):
  complete    - the whole sentence, then silence (Jester should reply)
  incomplete  - the sentence cut right after a word partway through, then
                silence (a thinking pause: Jester should keep waiting)
Each is streamed in 32 ms frames through Silero VAD; when VAD has heard
STOP_MS of silence, Smart Turn judges the audio so far.

Usage: .venv/bin/python bench_turn.py [--device cpu|gpu]
Writes results/turn.json.
"""
import argparse
import json
import os
import random
import time

import numpy as np
import onnxruntime as ort
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

SR = 16000
FRAME = 512  # 32 ms, Silero v5 frame size at 16 kHz
STOP_MS = 200  # VAD silence before asking Smart Turn (Pipecat default)
TAIL_S = 3.0  # silence appended after each turn
FUNCTION_WORDS = {"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "with",
                  "for", "that", "which", "who", "his", "her", "their", "my", "is", "was",
                  "as", "at", "by", "from", "if", "when", "we", "i", "he", "she", "they"}


class Silero:
    def __init__(self, path="data/models/silero_vad.onnx"):
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 1
        self.s = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros((1, 64), dtype=np.float32)

    def __call__(self, frame):
        x = np.concatenate([self.ctx, frame[None, :]], axis=1).astype(np.float32)
        out, self.state = self.s.run(None, {"input": x, "state": self.state,
                                            "sr": np.array(SR, dtype=np.int64)})
        self.ctx = x[:, -64:]
        return float(out[0][0])


class SmartTurn:
    def __init__(self, device):
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor
        name = f"smart-turn-v3.2-{device}.onnx"
        path = hf_hub_download("pipecat-ai/smart-turn-v3", name)
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        prov = ["CUDAExecutionProvider"] if device == "gpu" else ["CPUExecutionProvider"]
        self.s = ort.InferenceSession(path, sess_options=so, providers=prov)
        self.fe = WhisperFeatureExtractor(chunk_length=8)
        self.name = name

    def __call__(self, audio):
        # Keep the last 8 s; zero-pad at the START so the turn end sits at the
        # end of the window (matches smart-turn audio_utils.py).
        audio = audio[-8 * SR:]
        if len(audio) < 8 * SR:
            audio = np.pad(audio, (8 * SR - len(audio), 0))
        feats = self.fe(audio, sampling_rate=SR, return_tensors="np", padding="max_length",
                        max_length=8 * SR, truncation=True, do_normalize=True)
        x = feats.input_features.astype(np.float32)
        return float(self.s.run(None, {"input_features": x})[0][0].item())


def build_cases():
    cache = "data/turn_cases.json"
    if os.path.exists(cache):
        return json.load(open(cache))
    from bench_stt import add_nvidia_libs
    add_nvidia_libs()
    from faster_whisper import WhisperModel
    m = WhisperModel("small.en", device="cuda", compute_type="float16")
    rng = random.Random(7)
    cases = []
    for c in json.load(open("data/clips.json")):
        segs, _ = m.transcribe(c["file"], word_timestamps=True, beam_size=1, language="en")
        words = [w for s in segs for w in s.words]
        if len(words) < 6:
            continue
        cases.append({"file": c["file"], "kind": "complete", "end": words[-1].end,
                      "text": " ".join(w.word.strip() for w in words)})
        mid = [i for i in range(len(words) - 1)
               if 0.3 <= i / len(words) <= 0.8 and words[i + 1].start - words[i].end < 0.25]
        func = [i for i in mid if words[i].word.strip(" ,.").lower() in FUNCTION_WORDS]
        for kind, pool in (("incomplete-function-word", func), ("incomplete-any-word", mid)):
            if pool:
                i = rng.choice(pool)
                cases.append({"file": c["file"], "kind": kind, "end": words[i].end,
                              "text": " ".join(w.word.strip() for w in words[: i + 1]) + " ..."})
    json.dump(cases, open(cache, "w"), indent=1)
    return cases


def run_case(case, vad, st, noise):
    """Stream the turn; ask Smart Turn at every VAD pause. Returns all checks."""
    audio, _ = sf.read(case["file"], dtype="float32")
    speech = audio[: int((case["end"] + 0.05) * SR)]
    stream = np.concatenate([speech, noise[: int(TAIL_S * SR)]])
    vad.reset()
    speaking, silent_frames, checks = False, 0, []
    for n in range(len(stream) // FRAME):
        p = vad(stream[n * FRAME:(n + 1) * FRAME])
        if p > 0.5:
            speaking, silent_frames = True, 0
        elif speaking and p < 0.35:
            silent_frames += 1
            if silent_frames * FRAME / SR * 1000 >= STOP_MS:
                t_audio = (n + 1) * FRAME / SR
                t0 = time.perf_counter()
                prob = st(stream[: (n + 1) * FRAME])
                infer_ms = (time.perf_counter() - t0) * 1000
                checks.append({"t": round(t_audio, 3), "prob": round(prob, 4),
                               "infer_ms": round(infer_ms, 1),
                               "final": t_audio > case["end"]})
                speaking = False  # one check per pause, like Pipecat
    return {"checks": checks}


def decide(row, thr):
    """First check above thr ends the turn. Returns (time_s, infer_ms, is_final_pause) or None."""
    for c in row["checks"]:
        if c["prob"] > thr:
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu", choices=["cpu", "gpu"])
    a = ap.parse_args()
    if a.device == "gpu":
        from bench_stt import add_nvidia_libs
        add_nvidia_libs()

    cases = build_cases()
    vad, st = Silero(), SmartTurn(a.device)
    noise = (np.random.default_rng(0).standard_normal(int(TAIL_S * SR)) * 1e-4).astype(np.float32)
    st(np.zeros(SR, dtype=np.float32))  # warm-up

    rows = [dict(c, **run_case(c, vad, st, noise)) for c in cases]
    kinds = sorted({r["kind"] for r in rows})
    infer = [c["infer_ms"] for r in rows for c in r["checks"]]
    summary = {"model": st.name, "stop_ms": STOP_MS,
               "cases": {k: sum(r["kind"] == k for r in rows) for k in kinds},
               "checks_total": len(infer),
               "mid_sentence_pauses_per_turn": round(
                   sum(1 for r in rows for c in r["checks"] if not c["final"]) / len(rows), 2),
               "infer_ms_mean": round(float(np.mean(infer)), 1),
               "infer_ms_p90": round(float(np.percentile(infer, 90)), 1),
               "no_final_check": sum(not any(c["final"] for c in r["checks"]) for r in rows)}
    sweep = {}
    for thr in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95):
        row = {}
        comp = [r for r in rows if r["kind"] == "complete"]
        d = [decide(r, thr) for r in comp]
        early = [x for x in d if x and not x["final"]]
        ok = [(x, r) for x, r in zip(d, comp) if x and x["final"]]
        row["complete_cut_early_pct"] = round(100 * len(early) / len(comp), 1)
        row["complete_replied_on_time_pct"] = round(100 * len(ok) / len(comp), 1)
        row["complete_fell_back_to_timeout_pct"] = round(100 * sum(x is None for x in d) / len(comp), 1)
        if ok:
            row["complete_delay_ms_mean"] = round(float(np.mean(
                [(x["t"] - r["end"]) * 1000 + x["infer_ms"] for x, r in ok])))
        for k in kinds:
            if k.startswith("incomplete"):
                inc = [r for r in rows if r["kind"] == k]
                di = [decide(r, thr) for r in inc]
                row[f"{k}_cut_at_thinking_pause_pct"] = round(
                    100 * sum(1 for x in di if x and x["final"]) / len(inc), 1)
                row[f"{k}_cut_anywhere_pct"] = round(100 * sum(x is not None for x in di) / len(inc), 1)
        sweep[str(thr)] = row
    summary["threshold_sweep"] = sweep
    os.makedirs("results", exist_ok=True)
    out = f"results/turn-{a.device}.json"
    json.dump({"summary": summary, "rows": rows}, open(out, "w"), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
