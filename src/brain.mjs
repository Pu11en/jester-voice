import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const LEAN_ARGS = [
  "-c", "mcp_servers={}",
  "-c", 'web_search="disabled"',
  "--disable", "apps",
  "--disable", "browser_use",
  "--disable", "browser_use_external",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--disable", "hooks",
  "--disable", "goals",
  "--disable", "in_app_browser",
];

export const JESTER_INSTRUCTIONS =
  "You are Jester, a voice assistant in a Discord voice room. Your words are " +
  "spoken aloud, so reply like a person talking: one or two short sentences, " +
  "no lists, no markdown, no code. Never invent facts about agent sessions; " +
  "say you'll check instead.";

const sentenceEnd = /[.!?](?:["'”’)]*)\s+/;

/** Persistent Codex app-server bridge used by Jester's voice conversation. */
export class Brain extends EventEmitter {
  constructor({
    command = process.env.CODEX_BIN || "codex",
    args = LEAN_ARGS,
    model = "gpt-6-luna",
    effort = "low",
    cwd = "/tmp",
    requestTimeoutMs = 60_000,
    stallMs = 2_500,
    spawnProcess = spawn,
  } = {}) {
    super();
    this.command = command;
    this.args = [...args];
    this.model = model;
    this.effort = effort;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stallMs = stallMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.threadId = null;
    this.nextId = 0;
    this.pending = new Map();
    this.context = [];
    this.activeTurn = null;
    this.starting = null;
    this.closed = false;
  }

  async prewarm() {
    if (this.closed) throw new Error("Brain is closed");
    if (this.threadId) return this.threadId;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    const child = this.spawnProcess(this.command, ["app-server", ...this.args], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      if (!this.closed) this.#fail(new Error(`Codex app-server exited (${code ?? signal})`));
    });
    const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (Object.hasOwn(message, "id")) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      } else if (message.method) {
        this.emit("notification", message);
      }
    });

    await this.#request("initialize", {
      clientInfo: { name: "jester-voice", title: "Jester voice", version: "0.1.0" },
    });
    this.#notify("initialized");
    const started = await this.#request("thread/start", {
      model: this.model,
      baseInstructions: JESTER_INSTRUCTIONS,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd: this.cwd,
    });
    this.threadId = started?.thread?.id;
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id");
    return this.threadId;
  }

  /** Ask Jester and yield completed sentence strings as deltas arrive. */
  async *ask(text, { speaker } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("text must be non-empty");
    const threadId = await this.prewarm();
    if (this.activeTurn) throw new Error("A brain turn is already running");
    const priorContext = this.context.splice(0);
    const input = [];
    if (priorContext.length) {
      input.push({ type: "text", text: `[Conversation context: ${priorContext.join("\n")}]` });
    }
    input.push({ type: "text", text: speaker ? `[${speaker}]: ${text}` : text });

    const state = { threadId, turnId: null, interrupted: false };
    this.activeTurn = state;
    const notifications = [];
    let wake;
    const onNotification = (message) => {
      if (message.params?.threadId !== threadId) return;
      if (state.turnId && message.params?.turnId && message.params.turnId !== state.turnId) return;
      notifications.push(message);
      wake?.();
    };
    const onFatal = (error) => {
      notifications.push({ method: "error", params: { threadId, message: error.message } });
      wake?.();
    };
    this.on("notification", onNotification);
    this.on("fatal", onFatal);
    let firstWord = false;
    const stallTimer = setTimeout(() => {
      if (!firstWord && this.activeTurn === state) this.emit("thinking", { threadId, speaker });
    }, this.stallMs);
    stallTimer.unref?.();
    try {
      const started = await this.#request("turn/start", {
        threadId,
        effort: this.effort,
        input,
      });
      state.turnId = started?.turn?.id;
      if (!state.turnId) throw new Error("Codex app-server did not return a turn id");
      let remainder = "";
      while (true) {
        if (!notifications.length) await new Promise((resolve) => { wake = resolve; });
        wake = null;
        while (notifications.length) {
          const message = notifications.shift();
          const params = message.params || {};
          if (params.turnId && params.turnId !== state.turnId) continue;
          if (message.method === "item/agentMessage/delta") {
            const delta = params.delta || "";
            if (!firstWord && /\S/.test(delta)) {
              firstWord = true;
              clearTimeout(stallTimer);
            }
            remainder += delta;
            let match;
            while ((match = sentenceEnd.exec(remainder))) {
              const sentence = remainder.slice(0, match.index + match[0].trimEnd().length).trim();
              remainder = remainder.slice(match.index + match[0].length);
              if (sentence) yield sentence;
            }
          } else if (message.method === "turn/completed") {
            if (!state.interrupted && remainder.trim()) yield remainder.trim();
            return;
          } else if (message.method === "error") {
            throw new Error(params.message || "Codex app-server reported an error");
          }
        }
      }
    } finally {
      clearTimeout(stallTimer);
      this.off("notification", onNotification);
      this.off("fatal", onFatal);
      if (this.activeTurn === state) this.activeTurn = null;
    }
  }

  /** Interrupt the current response; safe to call when no turn is active. */
  async interrupt() {
    const turn = this.activeTurn;
    if (!turn?.turnId) return false;
    turn.interrupted = true;
    await this.#request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
    return true;
  }

  /** Add heard conversation to the next prompt without triggering a new answer. */
  injectContext(text) {
    if (typeof text !== "string" || !text.trim()) return;
    this.context.push(text.trim());
  }

  async close() {
    this.closed = true;
    this.child?.kill();
    this.child = null;
    this.threadId = null;
    this.#fail(new Error("Brain closed"));
  }

  #notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  #request(method, params) {
    const id = ++this.nextId;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out calling ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("fatal", error);
  }
}
