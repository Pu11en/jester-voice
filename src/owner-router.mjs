import { parseOwnerIntent } from "./owner-intent.mjs";

const PRONOUNS = new Set(["him", "her", "them", "that one", "that session"]);
const BIND_MS = 60_000;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Deterministic owner actions; model output never enters this action path. */
export class OwnerRouter {
  constructor({ client, ownerId, now = () => Date.now() }) {
    this.client = client;
    this.ownerId = String(ownerId);
    this.now = now;
    this.bound = null;
  }

  reset() { this.bound = null; }

  async sessionTags() {
    const sessions = await this.client.snapshot();
    return sessions.filter(s => !s.closed).flatMap(s => [s.tag, ...s.aliases]).filter(Boolean);
  }

  async #target(name, allowReference) {
    if (PRONOUNS.has(name.toLowerCase())) {
      if (!allowReference || !this.bound || this.now() > this.bound.until) return { kind: "unknown" };
      const latest = (await this.client.snapshot()).find(s => s.threadId === this.bound.threadId && !s.closed);
      return latest ? { kind: "found", session: latest } : { kind: "unknown" };
    }
    return this.client.resolveTag(name);
  }

  async handle(text, { speakerId, allowReference = false } = {}) {
    if (String(speakerId) !== this.ownerId) return null;
    const intent = parseOwnerIntent(text);
    if (!intent) return null;
    if (intent.kind === "clarify") return "Please say the final task once more so I send the right words.";
    if (intent.kind === "status-all") {
      const sessions = (await this.client.snapshot()).filter(s => !s.closed && s.state === "running");
      if (!sessions.length) return "No EBI sessions are running right now.";
      return `Running: ${sessions.map(s => s.tag || s.name || "unnamed session").join(", ")}.`;
    }
    const resolved = await this.#target(intent.target, allowReference);
    if (resolved.kind === "ambiguous") return `More than one session matches ${intent.target}. Please name the exact one.`;
    if (resolved.kind !== "found") return `I can't find an open session named ${intent.target}.`;
    const session = resolved.session;
    const name = session.tag || session.name || "that session";
    if (intent.kind === "status-one") {
      const task = session.currentTask ? ` ${session.currentTask}` : "";
      return `${name} is ${session.state}.${task}`;
    }
    if (intent.kind === "stop") {
      const result = await this.client.stopTurn(session.threadId, this.ownerId);
      this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
      return result.status === "stopped" ? `I stopped ${name}'s current turn.` : `${name} is already idle.`;
    }
    if (intent.kind !== "message") return null;
    this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
    let receipt;
    try {
      receipt = await this.client.sendSpoken({
        threadId: session.threadId, speakerId: this.ownerId, text: intent.instruction,
      });
      for (let tries = 0; tries < 15 && receipt.status === "accepted"; tries += 1) {
        await wait(100);
        receipt = await this.client.spokenReceipt(session.threadId, receipt.request_id);
      }
    } catch {
      return `I couldn't verify that ${name} received it. I won't send it twice.`;
    }
    if (receipt.status === "posted") return `I posted your task to ${name}.`;
    if (receipt.status === "failed") return `Posting to ${name} failed. Please check the thread before trying again.`;
    return `${name} accepted the task, but I couldn't verify the post yet.`;
  }
}
