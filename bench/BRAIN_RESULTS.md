# Brain Bridge Benchmark — 2026-09-27

Codex CLI 0.157.1 using the owner's ChatGPT-subscription login (no API key). Model `gpt-6-luna`, reasoning effort `low`. Raw data is in `results/brain.jsonl`; the script is `bench_brain.py`.

## `codex exec` (one process per turn): too slow
- **7.4 s** per reply. About 2.6 s is process startup, then about 4.7 s until the whole answer arrives.
- No streaming: the text arrives all at once at the end.
- **22k input tokens** for a one-line question, even with `--ignore-user-config --ignore-rules -c project_doc_max_bytes=0`. That is Codex's built-in coding-agent prompt plus its tool definitions.

## `codex app-server` (one long-lived process, JSON-RPC over stdio): the pick
- Server ready in 0.6 s and a new thread in 0.4 s. Both happen once, not per turn.
- `thread/start` accepts **`baseInstructions`**, which replaces Codex's coding-agent prompt with a short Jester voice persona. Replies came back spoken-style: one or two sentences.
- **Streaming works** (`item/agentMessage/delta`), so TTS can start on the first sentence.
- **Context carries over**: "What did I just say I'm working on?" was answered correctly.
- **Barge-in works**: `turn/interrupt` stopped a long answer in **3–5 ms**, with status `interrupted`.
- The protocol also has **`DynamicToolCall`** (tools the client provides), `turn/steer` and `thread/inject_items`. These are the natural hooks for typed Jester Control actions and for injecting EBI state.

### Latency, time to first streamed word
- **First turn of a thread: 3.3–4.9 s** (cold cache), so the thread should be pre-warmed when the owner joins voice.
- **Warm turns, lean run: 1.0, 1.1, 2.0, 2.1 s.**
- **Warm turns, default run: 1.2, 1.2, 7.4, 11.1 s.** The two slow turns contained no tool calls or other events, so this is server-side variance.
- The lean run disabled apps, browser use and computer use. It was steadier and its first turn used 14k input tokens instead of 18k.

### Tokens
- About 20k input tokens per turn in the lean run, around 99% served from cache after the first turn. The rest is Codex's tool definitions and user-level instructions.
- `mcp_servers={}` did **not** stop the 8 configured MCP servers from starting (12 startup events). A dedicated minimal Codex profile or config should remove them; auth must stay shared.

## What this means for Jester
- **Brain = Codex app-server + Luna over subscription: viable.** No API billing, and it streams and interrupts cleanly.
- The first word takes about 1–2 s on warm turns, which alone uses most of the ≤1.5 s budget. On top: turn detection about 0.2–0.3 s, STT about 0.13 s, first TTS audio about 0.28 s.
- Mitigations already in the design:
  1. **Speculative start**: send the transcript at each likely end of turn, and discard the draft if the owner keeps talking.
  2. **Pre-warm the thread** when the owner joins.
  3. Let Jester speak the first sentence as soon as it streams.
  4. If needed, a tiny local acknowledgement ("mm, checking") for EBI lookups.
- Occasional 7–11 s stalls happened in one run. Jester needs a "still thinking" cue after about 2.5 s and should log stalls. Re-measure during the live feel test.
- Luna refused to pretend to message Zoro. That's correct: real EBI actions must come through Jester Control tools (DynamicToolCall), not the model's imagination.
