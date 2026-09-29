import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { childEnv } from "./child-env.mjs";
import { JESTER_INSTRUCTIONS, brainError, createSentenceStream, isUsageLimitText } from "./brain.mjs";

export { createSentenceStream };

/** The fast model for a spoken reply; a Sonnet id works too but answers more slowly. */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

/**
 * Flags that keep the Claude CLI a plain chat model for Jester: no built-in tools, no
 * MCP servers, no hooks, plugins or CLAUDE.md files (--safe-mode), no session files on
 * disk and no permission prompts (nothing could ask). `claude --help` (2.1.284) has no
 * --max-turns; without tools a turn is one message anyway.
 */
export const LEAN_CLAUDE_ARGS = Object.freeze([
  "--tools", "",
  "--strict-mcp-config",
  "--safe-mode",
  "--no-session-persistence",
  "--permission-prompts", "none",
]);

/** Provider settings that would move the CLI off Drew's Claude plan login: a paid API key,
 *  another token, or another endpoint that would receive the login. */
export const PLAN_ONLY_ENV_KEYS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);

/** Extended thinking off: Haiku 4.5 otherwise streams a thinking block first. Measured
 *  2026-09-29 (one cold turn each): first sentence 3.5 s with thinking, 2.1 s without. */
export const CLAUDE_FAST_ENV = Object.freeze({ MAX_THINKING_TOKENS: "0" });

function claudeEnv() {
  const env = childEnv(process.env, CLAUDE_FAST_ENV);
  for (const key of PLAN_ONLY_ENV_KEYS) delete env[key];
  return env;
}

// The CLI tags a failed assistant message with an error kind; map it to a brain reason.
const ASSISTANT_ERROR_REASONS = Object.freeze({
  rate_limit: "usageLimitExceeded",
  authentication_failed: "authFailed",
  billing_error: "billing",
  server_error: "unreachable",
  invalid_request: "invalidRequest",
});

const authFailure = /\b(?:not logged in|log ?in|authentication|unauthori[sz]ed|invalid api key|oauth token)\b/i;

function withReason(error, reason) {
  if (error && typeof error === "object" && error.reason === undefined) error.reason = reason;
  return error;
}

/** Build a reasoned Error from an assistant line that carries `error`. */
function assistantError(message) {
  const text = (message.message?.content || [])
    .map((block) => (typeof block === "string" ? block : block?.text || ""))
    .join(" ").trim();
  const kind = typeof message.error === "string" ? message.error : message.error?.type;
  const reason = ASSISTANT_ERROR_REASONS[kind]
    ?? (isUsageLimitText(text) ? "usageLimitExceeded" : authFailure.test(text) ? "authFailed" : "failed");
  return brainError(text || `Claude CLI reported ${kind || "an error"}`, reason, { kind });
}

/** The brain reason for an API HTTP status the CLI reports on a failed result, if any. */
function statusReason(status) {
  if (status === 429) return "usageLimitExceeded";
  if (status === 401 || status === 403) return "authFailed";
  if (status >= 500) return "unreachable";
  return null;
}

/**
 * Build a reasoned Error from a result line with is_error or a non-success subtype.
 * `limitHit` is set when the CLI streamed a rejected rate_limit_event during the turn.
 */
function resultError(message, { limitHit = false } = {}) {
  const errors = Array.isArray(message.errors) ? message.errors.filter((item) => typeof item === "string") : [];
  const text = (typeof message.result === "string" && message.result.trim())
    || errors.join("; ")
    || message.error?.message
    || `Claude CLI turn ${message.subtype || "failed"}`;
  const status = Number.isInteger(message.api_error_status) ? message.api_error_status : null;
  const reason = (limitHit ? "usageLimitExceeded" : null)
    ?? statusReason(status)
    ?? (isUsageLimitText(text) ? "usageLimitExceeded" : authFailure.test(text) ? "authFailed" : "failed");
  return brainError(text, reason, { subtype: message.subtype ?? null, status });
}

/** Text of a streamed content_block_delta line, or null for any other stream event. */
function deltaText(message) {
  const event = message.event;
  if (event?.type !== "content_block_delta") return null;
  const delta = event.delta;
  if (!delta || (delta.type !== undefined && delta.type !== "text_delta")) return null;
  return typeof delta.text === "string" ? delta.text : null;
}

/**
 * Claude-backed brain with the same interface as the Codex `Brain`: one persistent
 * `claude -p` process in bidirectional stream-json mode, one JSON line per turn on
 * stdin, sentences yielded as text deltas stream back. Memory across turns lives in
 * the CLI's own session plus `this.context`, exactly like the Codex brain.
 */
export class ClaudeBrain extends EventEmitter {
  /**
   * `turnTimeoutMs` is the stalled-turn limit: a turn with no output for that long is
   * treated as hung, the CLI is restarted and ask() rejects with reason "timeout".
   * `interruptTimeoutMs` bounds how long an interrupted turn may take to end before
   * the CLI is killed and respawned on the next turn.
   */
  constructor({
    command = process.env.CLAUDE_BIN || "claude",
    args = LEAN_CLAUDE_ARGS,
    model = DEFAULT_CLAUDE_MODEL,
    systemPrompt = JESTER_INSTRUCTIONS,
    cwd = "/tmp",
    turnTimeoutMs = 10_000,
    interruptTimeoutMs = 1_500,
    restartBaseMs = 250,
    restartMaxMs = 5_000,
    stallMs = 2_500,
    contextLimit = 24,
    spawnProcess = spawn,
  } = {}) {
    super();
    this.name = "claude";
    this.command = command;
    this.args = [...args];
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.cwd = cwd;
    this.turnTimeoutMs = turnTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.restartBaseMs = restartBaseMs;
    this.restartMaxMs = restartMaxMs;
    this.stallMs = stallMs;
    this.contextLimit = contextLimit;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.sessionId = null;
    this.rateLimit = null; // the last rate_limit_event's info, for diagnostics
    this.nextId = 0;
    this.controls = new Map();
    this.context = [];
    this.turn = null;
    this.starting = null;
    this.closed = false;
    this.failures = 0;
    this.lastFailureAt = 0;
  }

  /** The argv the CLI is spawned with; the prompt itself never appears here. */
  get argv() {
    return [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", this.model,
      "--system-prompt", this.systemPrompt,
      ...this.args,
    ];
  }

  /** Start the CLI if it is not running so the first turn does not pay its boot time. */
  async prewarm() {
    if (this.closed) throw brainError("Brain is closed", "closed");
    if (this.child) return this.child.pid ?? true;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    const backoff = Math.min(this.restartMaxMs, this.restartBaseMs * (2 ** Math.max(0, this.failures - 1)));
    const wait = backoff - (Date.now() - this.lastFailureAt);
    if (this.failures && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.closed) throw brainError("Brain is closed", "closed");
    let child;
    try {
      child = this.spawnProcess(this.command, this.argv, {
        cwd: this.cwd,
        env: claudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#fail(withReason(error, "unreachable"));
      throw error;
    }
    this.child = child;
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-400);
    });
    child.once("error", (error) => this.#fail(withReason(error, "unreachable"), child));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = stderrTail.trim().split("\n").at(-1)?.trim();
      const message = `Claude CLI exited (${code ?? signal})${detail ? `: ${detail.slice(0, 200)}` : ""}`;
      this.#fail(brainError(message, "unreachable"), child);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(child, line));
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // `failures` is reset by a completed turn, so a crash-looping CLI keeps backing off.
    return child.pid ?? true;
  }

  #onLine(child, line) {
    if (child !== this.child) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "control_response") {
      const control = this.controls.get(message.response?.request_id);
      if (!control) return;
      this.controls.delete(message.response.request_id);
      clearTimeout(control.timer);
      control.resolve(message.response);
      return;
    }
    if (message.type === "system" && message.subtype === "init" && message.session_id) {
      this.sessionId = message.session_id;
    }
    if (message.type === "result" && this.turn) {
      // The turn is over at the CLI whether or not anyone is still listening.
      this.#finishTurn(this.turn);
    }
    this.emit("notification", message);
  }

  /**
   * Ask Jester and yield completed sentence strings as deltas arrive. Rejects with an
   * Error carrying `reason` when the turn fails ("usageLimitExceeded", "timeout", ...).
   */
  async *ask(text, { speaker, requestId, context = null, whole = false } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("text must be non-empty");
    if (this.turn?.interrupted) await this.turn.settling; // let a stopped reply wind down
    await this.prewarm();
    if (this.turn) throw brainError("A brain turn is already running", "busy");
    const priorContext = this.context.splice(0);
    const content = [];
    if (priorContext.length) {
      content.push({ type: "text", text: `[Conversation context: ${priorContext.join("\n")}]` });
    }
    if (context) content.push({ type: "text", text: `[Verified context for this turn:\n${context}]` });
    content.push({ type: "text", text: speaker ? `[${speaker}]: ${text}` : text });

    const state = { interrupted: false, finished: false, error: null, limitHit: false,
      settling: null, wake: null };
    state.done = new Promise((resolve) => { state.finish = resolve; });
    this.turn = state;
    const queue = [];
    let turnTimer = null;
    const armTurnTimer = () => {
      clearTimeout(turnTimer);
      turnTimer = setTimeout(() => {
        this.#fail(brainError("Claude CLI turn timed out", "timeout"), this.child);
      }, this.turnTimeoutMs);
      turnTimer.unref?.();
    };
    const onNotification = (message) => {
      queue.push(message);
      if (turnTimer) armTurnTimer(); // any output for this turn means it is not stalled
      state.wake?.();
    };
    const onFatal = (error) => {
      queue.push({ type: "fatal", error });
      state.wake?.();
    };
    this.on("notification", onNotification);
    this.on("fatal", onFatal);
    let firstWord = false;
    const stallTimer = setTimeout(() => {
      if (!firstWord && this.turn === state) this.emit("thinking", { sessionId: this.sessionId, speaker });
    }, this.stallMs);
    stallTimer.unref?.();
    const stream = createSentenceStream({ whole });
    let heard = ""; // everything streamed so far, checked for a usage-limit notice
    try {
      this.#write({ type: "user", message: { role: "user", content } });
      armTurnTimer();
      while (true) {
        if (!queue.length) {
          if (state.interrupted) return;
          await new Promise((resolve) => { state.wake = resolve; });
          state.wake = null;
        }
        while (queue.length) {
          const message = queue.shift();
          if (message.type === "stream_event") {
            const delta = deltaText(message);
            if (delta === null || state.interrupted) continue;
            if (!firstWord && /\S/.test(delta)) {
              firstWord = true;
              clearTimeout(stallTimer);
              this.emit("firstWord", { sessionId: this.sessionId, speaker, requestId, at: Date.now() });
            }
            heard += delta;
            if (isUsageLimitText(heard)) {
              void this.interrupt().catch(() => {});
              throw brainError(heard.trim(), "usageLimitExceeded");
            }
            for (const line of stream.push(delta)) yield line;
          } else if (message.type === "assistant") {
            if (message.error) state.error = assistantError(message);
          } else if (message.type === "rate_limit_event") {
            this.rateLimit = message.rate_limit_info ?? null;
            if (this.rateLimit?.status === "rejected") state.limitHit = true;
          } else if (message.type === "result") {
            clearTimeout(turnTimer);
            turnTimer = null;
            if (state.interrupted) return;
            if (message.is_error || (message.subtype && message.subtype !== "success")) {
              throw state.error ?? resultError(message, { limitHit: state.limitHit });
            }
            this.failures = 0;
            for (const line of stream.flush()) yield line;
            return;
          } else if (message.type === "fatal") {
            if (state.interrupted) return;
            throw state.error ?? message.error;
          }
        }
      }
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(turnTimer);
      this.off("notification", onNotification);
      this.off("fatal", onFatal);
      // A reply abandoned mid-stream is stopped at the CLI so the next turn starts clean.
      if (this.turn === state && !state.finished && !state.interrupted) {
        void this.interrupt().catch(() => {});
      }
    }
  }

  /**
   * Interrupt the current response; safe to call when no turn is active. Resolves once
   * the CLI has ended the turn, or after `interruptTimeoutMs` with the CLI killed.
   */
  async interrupt() {
    const turn = this.turn;
    if (!turn || turn.finished) return false;
    if (!turn.settling) {
      turn.interrupted = true;
      turn.wake?.();
      const child = this.child;
      turn.settling = (async () => {
        const timer = setTimeout(() => {
          this.#fail(brainError("Claude CLI did not stop after an interrupt", "interrupted"), child);
        }, this.interruptTimeoutMs);
        timer.unref?.();
        try {
          this.#control({ subtype: "interrupt" }).catch(() => {});
          await turn.done;
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    await turn.settling;
    return true;
  }

  /** Add heard conversation to the next prompt without triggering a new answer. */
  injectContext(text) {
    if (typeof text !== "string" || !text.trim()) return;
    this.context.push(text.trim());
    if (this.context.length > this.contextLimit) this.context.splice(0, this.context.length - this.contextLimit);
  }

  async close() {
    this.closed = true;
    this.#fail(brainError("Brain closed", "closed"));
  }

  #control(request) {
    const id = `control-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(brainError(`Claude CLI did not answer ${request.subtype}`, "timeout"));
      }, this.interruptTimeoutMs);
      timer.unref?.();
      this.controls.set(id, { resolve, reject, timer });
      try {
        this.#write({ type: "control_request", request_id: id, request });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw brainError("Claude CLI is not running", "unreachable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #finishTurn(turn) {
    if (turn.finished) return;
    turn.finished = true;
    if (this.turn === turn) this.turn = null;
    turn.finish();
  }

  /** Drop the CLI, reject pending control requests and emit "fatal" with a reasoned error. */
  #fail(error, child = null) {
    if (child && child !== this.child) return;
    withReason(error, "failed");
    const failedChild = this.child;
    this.child = null;
    this.sessionId = null;
    if (!this.closed) {
      this.failures += 1;
      this.lastFailureAt = Date.now();
    }
    failedChild?.kill();
    for (const control of this.controls.values()) {
      clearTimeout(control.timer);
      control.reject(error);
    }
    this.controls.clear();
    if (this.turn) this.#finishTurn(this.turn);
    this.emit("fatal", error);
  }
}
