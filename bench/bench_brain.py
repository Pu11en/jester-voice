"""Brain bridge benchmark: Codex app-server (subscription auth) with GPT-6 Luna.

Keeps one `codex app-server` process alive (no per-turn startup), replaces
Codex's coding-agent instructions with a short Jester prompt, and streams the
reply. Measures: thread start, time to first streamed word, total time,
input tokens per turn, and multi-turn context carry-over.

Usage: python3 bench_brain.py [--model gpt-6-luna] [--effort low]
Appends to results/brain.jsonl.
"""
import argparse
import json
import os
import subprocess
import threading
import time
import queue

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

JESTER = (
    "You are Jester, a voice assistant in a Discord voice room. Your words are "
    "spoken aloud, so reply like a person talking: one or two short sentences, "
    "no lists, no markdown, no code. Never invent facts about agent sessions; "
    "say you'll check instead."
)

TURNS = [
    "Hey Jester, can you hear me?",
    "Cool. I'm working on a voice bot for Discord and I want it to feel natural. Any quick tip?",
    "What did I just say I'm working on?",
    "Um, actually, what's a good name for a jester, like, one word?",
    "Tell Zoro to fix the login bug.",
]


# Strip coding-agent baggage: no MCP servers, apps, browser/computer use, web search.
LEAN_ARGS = ["-c", "mcp_servers={}", "-c", "web_search=\"disabled\"",
             "--disable", "apps", "--disable", "browser_use", "--disable", "browser_use_external",
             "--disable", "computer_use", "--disable", "image_generation", "--disable", "hooks",
             "--disable", "goals", "--disable", "in_app_browser"]


class AppServer:
    def __init__(self, extra_args):
        self.p = subprocess.Popen(
            ["codex", "app-server", *extra_args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd="/tmp")
        self.q = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            try:
                self.q.put((time.perf_counter(), json.loads(line)))
            except json.JSONDecodeError:
                pass

    def send(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            self.next_id += 1
            msg["id"] = self.next_id
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        return msg.get("id")

    def wait(self, pred, timeout=120):
        end = time.perf_counter() + timeout
        seen = []
        while time.perf_counter() < end:
            try:
                t, m = self.q.get(timeout=end - time.perf_counter())
            except queue.Empty:
                break
            seen.append((t, m))
            if m.get("method") == "error" or ("error" in m and "id" in m):
                raise RuntimeError(json.dumps(m)[:500])
            if pred(m):
                return t, m, seen
        raise TimeoutError(f"timed out; last: {json.dumps(seen[-1][1])[:300] if seen else None}")

    def call(self, method, params=None, timeout=60):
        rid = self.send(method, params)
        _, m, _ = self.wait(lambda m: m.get("id") == rid, timeout)
        return m.get("result")

    def close(self):
        self.p.terminate()


def run(model, effort, lean):
    t0 = time.perf_counter()
    srv = AppServer(LEAN_ARGS if lean else [])
    srv.call("initialize", {"clientInfo": {"name": "jester-bench", "title": "Jester bench", "version": "0.1"}})
    srv.send("initialized", notify=True)
    ready_s = time.perf_counter() - t0

    t = time.perf_counter()
    th = srv.call("thread/start", {
        "model": model, "baseInstructions": JESTER, "ephemeral": True,
        "sandbox": "read-only", "approvalPolicy": "never", "cwd": "/tmp",
    })
    thread_id = th["thread"]["id"]
    thread_s = time.perf_counter() - t

    rows = []
    for text in TURNS:
        t = time.perf_counter()
        srv.call("turn/start", {"threadId": thread_id, "effort": effort,
                                "input": [{"type": "text", "text": text}]})
        first = None
        reply = ""
        usage = None
        events = {}
        while True:
            ts, m, seen = srv.wait(lambda m: m.get("method") in (
                "item/agentMessage/delta", "turn/completed", "thread/tokenUsage/updated"))
            for _, e in seen:
                k = e.get("method") or "response"
                if k == "item/started":
                    k += ":" + e["params"]["item"].get("type", "?")
                events[k] = events.get(k, 0) + 1
            meth = m["method"]
            if meth == "item/agentMessage/delta":
                if first is None:
                    first = ts - t
                reply += m["params"].get("delta", "")
            elif meth == "thread/tokenUsage/updated":
                usage = m["params"].get("tokenUsage", {}).get("last")
            else:
                done = ts - t
                break
        rows.append({"user": text, "reply": reply.strip(),
                     "first_word_ms": round(first * 1000) if first else None,
                     "total_ms": round(done * 1000),
                     "input_tokens": (usage or {}).get("inputTokens"),
                     "cached_tokens": (usage or {}).get("cachedInputTokens"),
                     "events": events})
        print(json.dumps(rows[-1]), flush=True)

    # Barge-in: start a long answer, interrupt after the first streamed words.
    t = time.perf_counter()
    turn = srv.call("turn/start", {"threadId": thread_id, "effort": effort, "input": [
        {"type": "text", "text": "Tell me a long story about a jester, at least ten sentences."}]})
    srv.wait(lambda m: m.get("method") == "item/agentMessage/delta")
    t_int = time.perf_counter()
    srv.call("turn/interrupt", {"threadId": thread_id, "turnId": turn["turn"]["id"]})
    ts, m, _ = srv.wait(lambda m: m.get("method") == "turn/completed")
    interrupt_ms = round((ts - t_int) * 1000)
    srv.close()
    return {"model": model, "effort": effort, "server_ready_ms": round(ready_s * 1000),
            "thread_start_ms": round(thread_s * 1000), "turns": rows,
            "interrupt_to_completed_ms": interrupt_ms,
            "interrupted_status": m["params"].get("turn", {}).get("status")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt-6-luna")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--lean", action="store_true")
    a = ap.parse_args()
    res = run(a.model, a.effort, a.lean)
    res["lean"] = a.lean
    os.makedirs("results", exist_ok=True)
    with open("results/brain.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")
    print(json.dumps({k: v for k, v in res.items() if k != "turns"}))


if __name__ == "__main__":
    main()
