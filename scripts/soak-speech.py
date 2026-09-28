#!/usr/bin/env python3
"""Exercise Jester's real speech worker with two local audio fixtures.

No Discord, EBI, or model API calls. Run with the project's bench virtualenv.
"""
import argparse
import base64
import json
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "bench/.venv/bin/python"
WORKER = ROOT / "worker/speech.py"
DATA = ROOT / "worker/tests/data"
RATE = 16_000
FRAME = 512


def frames(path):
    audio, source_rate = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if source_rate != RATE:
        positions = np.arange(round(len(audio) * RATE / source_rate)) * source_rate / RATE
        audio = np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)
    silence = 7.3 if path.name == "incomplete.wav" else 2.3
    audio = np.concatenate([audio, np.zeros(round(silence * RATE), dtype=np.float32)])
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    for offset in range(0, len(pcm), FRAME * 2):
        chunk = pcm[offset:offset + FRAME * 2]
        if len(chunk) < FRAME * 2:
            chunk += bytes(FRAME * 2 - len(chunk))
        yield base64.b64encode(chunk).decode("ascii")


def gpu_used():
    try:
        result = subprocess.run(
            ["/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=memory.used",
             "--format=csv,noheader,nounits"], check=True, capture_output=True,
            text=True, timeout=3,
        )
        return int(result.stdout.splitlines()[0].strip())
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=20.0)
    args = parser.parse_args()
    report = {"target_minutes": args.minutes, "turns": 0, "empty_turns": 0,
              "tts_sent": 0, "tts_done": 0, "tts_chunks": 0,
              "errors": [], "gpu_peak_mib": 0}
    ready = threading.Event()
    process = subprocess.Popen([str(PYTHON), str(WORKER)], cwd=ROOT,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1)

    def read_events():
        for line in process.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                report["errors"].append("invalid worker JSON")
                continue
            kind = event.get("ev")
            if kind == "ready":
                ready.set()
            elif kind == "turn_end":
                report["turns"] += 1
                report["empty_turns"] += not bool(event.get("text", "").strip())
            elif kind == "say_done":
                report["tts_done"] += 1
            elif kind == "audio_out":
                report["tts_chunks"] += 1

    def read_errors():
        for line in process.stderr:
            if "error" in line.lower() or "exception" in line.lower():
                report["errors"].append(line.strip()[:500])

    threading.Thread(target=read_events, daemon=True).start()
    threading.Thread(target=read_errors, daemon=True).start()
    if not ready.wait(90):
        report["errors"].append("worker did not become ready")
    start = time.monotonic()
    next_report = start + 60
    cycle = 0
    try:
        while ready.is_set() and time.monotonic() - start < args.minutes * 60:
            speaker = "owner" if cycle % 2 == 0 else "second-speaker"
            path = DATA / ("complete.wav" if cycle % 2 == 0 else "incomplete.wav")
            for pcm in frames(path):
                if process.poll() is not None or time.monotonic() - start >= args.minutes * 60:
                    break
                process.stdin.write(json.dumps({"op": "audio", "speaker": speaker,
                                                "pcm": pcm}, separators=(",", ":")) + "\n")
                process.stdin.flush()
                time.sleep(FRAME / RATE)
            if process.poll() is not None:
                report["errors"].append(f"worker exited early: {process.returncode}")
                break
            cycle += 1
            if cycle % 6 == 0 and time.monotonic() - start < args.minutes * 60 - 20:
                process.stdin.write(json.dumps({"op": "say", "id": f"soak-{cycle}",
                                                "text": "I heard you. What should we do next?"}) + "\n")
                process.stdin.flush()
                report["tts_sent"] += 1
            if time.monotonic() >= next_report:
                used = gpu_used()
                report["gpu_peak_mib"] = max(report["gpu_peak_mib"], used or 0)
                print(f"soak {round((time.monotonic()-start)/60, 1)}m: "
                      f"turns={report['turns']} errors={len(report['errors'])} "
                      f"gpu={used} MiB", flush=True)
                next_report += 60
            if report["errors"]:
                break
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - start, 1)
        deadline = time.monotonic() + 10
        while process.poll() is None and report["tts_done"] < report["tts_sent"] and time.monotonic() < deadline:
            time.sleep(0.1)
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        report["worker_exit"] = process.returncode
        report["cycles"] = cycle
        report["gpu_peak_mib"] = max(report["gpu_peak_mib"], gpu_used() or 0)
        output = ROOT / "sim/results/speech-soak.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)
    if report["errors"] or report["turns"] == 0 or report["worker_exit"] != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
