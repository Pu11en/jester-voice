import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

/** JSONL bridge to the GPU worker with bounded input buffering and lazy restart. */
export class WorkerClient extends EventEmitter {
  constructor({
    command,
    args = [],
    env = process.env,
    cwd = process.cwd(),
    spawnProcess = spawn,
    maxQueuedBytes = 2 * 1024 * 1024,
    restartBaseMs = 250,
    restartMaxMs = 5_000,
    sayTimeoutMs = 90_000,
    heartbeatMs = 20_000,
    heartbeatTimeoutMs = 8_000,
  } = {}) {
    super();
    if (!command) throw new Error("worker command is required");
    Object.assign(this, { command, args, env, cwd, spawnProcess, maxQueuedBytes, restartBaseMs, restartMaxMs, sayTimeoutMs, heartbeatMs, heartbeatTimeoutMs });
    this.child = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.failures = 0;
    this.lastFailureAt = 0;
    this.sayTimers = new Map();
    this.closed = false;
    this.starting = null;
    this.heartbeatTimer = null;
    this.heartbeatDeadline = null;
    this.heartbeatId = 0;
    this.heartbeatPending = null;
  }

  async start() {
    if (this.closed) throw new Error("Worker is closed");
    if (this.child) return this.child;
    if (this.starting) return this.starting;
    this.starting = this.#spawn();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async #spawn() {
    const backoff = Math.min(this.restartMaxMs, this.restartBaseMs * (2 ** Math.max(0, this.failures - 1)));
    const wait = backoff - (Date.now() - this.lastFailureAt);
    if (this.failures && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.closed) throw new Error("Worker is closed");
    const child = this.spawnProcess(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.once("error", (error) => this.#fail(error, child));
    child.once("exit", (code, signal) => this.#fail(new Error(`Speech worker exited (${code ?? signal})`), child));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.ev === "say_done") this.#clearSayTimer(event.id);
      if (event.ev === "ready") {
        this.failures = 0;
        this.#startHeartbeat();
      }
      if (event.ev === "pong" && String(event.id) === this.heartbeatPending) {
        clearTimeout(this.heartbeatDeadline);
        this.heartbeatDeadline = null;
        this.heartbeatPending = null;
      }
      this.emit("event", event);
    });
    child.stdin.on("drain", () => this.#flush());
    this.#flush();
    return child;
  }

  send(message) {
    if (this.closed) return false;
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (message.op === "reset") this.#dropSpeaker(message.speaker);
    if (message.op === "cancel") this.#dropReply(message.id);
    if (message.op === "audio" && this.queuedBytes + bytes > this.maxQueuedBytes) {
      this.emit("drop", { reason: "input_queue_full", speaker: String(message.speaker) });
      return false;
    }
    if (message.op === "say") this.#armSayTimer(message.id);
    this.queue.push({ line, bytes, op: message.op, speaker: String(message.speaker ?? ""), id: String(message.id ?? "") });
    this.queuedBytes += bytes;
    void this.start().catch((error) => this.#fail(error));
    this.#flush();
    return true;
  }

  #dropSpeaker(speaker) {
    const id = String(speaker);
    this.queue = this.queue.filter((entry) => {
      if (entry.op === "audio" && entry.speaker === id) {
        this.queuedBytes -= entry.bytes;
        return false;
      }
      return true;
    });
  }

  /** Discard buffered audio backlog while retaining only the freshest frames. */
  dropQueuedAudio(speaker, keepFrames = 0) {
    const id = String(speaker);
    const matching = this.queue.filter((entry) => entry.op === "audio" && entry.speaker === id).length;
    const dropCount = Math.max(0, matching - Math.max(0, keepFrames));
    let dropped = 0;
    this.queue = this.queue.filter((entry) => {
      if (entry.op !== "audio" || entry.speaker !== id) return true;
      if (dropped++ < dropCount) {
        this.queuedBytes -= entry.bytes;
        return false;
      }
      return true;
    });
  }

  #flush() {
    const stdin = this.child?.stdin;
    while (stdin?.writable && !stdin.writableNeedDrain && this.queue.length) {
      const item = this.queue.shift();
      this.queuedBytes -= item.bytes;
      try {
        if (!stdin.write(item.line)) break;
      } catch (error) {
        this.#fail(error, this.child);
        break;
      }
    }
  }

  #armSayTimer(id) {
    this.#clearSayTimer(id);
    const timer = setTimeout(() => this.#fail(new Error(`Speech worker timed out on reply ${id}`), this.child), this.sayTimeoutMs);
    timer.unref?.();
    this.sayTimers.set(String(id), timer);
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatPending) {
        this.#fail(new Error("Speech worker heartbeat timed out"), this.child);
        return;
      }
      const id = `heartbeat-${++this.heartbeatId}`;
      this.heartbeatPending = id;
      this.heartbeatDeadline = setTimeout(() => this.#fail(new Error("Speech worker heartbeat timed out"), this.child), this.heartbeatTimeoutMs);
      this.heartbeatDeadline.unref?.();
      this.send({ op: "ping", id });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #clearSayTimer(id) {
    const key = String(id);
    clearTimeout(this.sayTimers.get(key));
    this.sayTimers.delete(key);
  }

  #dropReply(id) {
    const key = String(id);
    this.queue = this.queue.filter((entry) => {
      if (entry.op === "say" && entry.id === key) {
        this.queuedBytes -= entry.bytes;
        return false;
      }
      return true;
    });
    this.#clearSayTimer(key);
  }

  #fail(error, child = null) {
    if (child && child !== this.child) return;
    const failed = this.child;
    this.child = null;
    this.queue = [];
    this.queuedBytes = 0;
    for (const timer of this.sayTimers.values()) clearTimeout(timer);
    this.sayTimers.clear();
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = null;
    this.heartbeatDeadline = null;
    this.heartbeatPending = null;
    if (!this.closed) {
      this.failures += 1;
      this.lastFailureAt = Date.now();
      this.emit("fatal", error);
    }
    failed?.kill();
  }

  async close() {
    this.closed = true;
    this.#fail(new Error("Worker closed"));
  }
}
