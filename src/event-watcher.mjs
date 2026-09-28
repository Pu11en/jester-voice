import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const utcNow = () => new Date().toISOString().replace("Z", "+00:00");

/** Polls EBI's read-only journal and keeps undelivered room updates on disk. */
export class EventWatcher {
  constructor({ client, conversation, presence, file = join(homedir(), ".local/share/jester-voice/events.json"),
    logger = console, now = () => Date.now(), intervalMs = 3_000,
    dependencies = null } = {}) {
    this.client = client;
    this.conversation = conversation;
    this.presence = presence;
    this.file = file;
    this.logger = logger;
    this.now = now;
    this.intervalMs = intervalMs;
    this.dependencies = dependencies;
    this.state = null;
    this.timer = null;
    this.running = false;
    this.polling = false;
  }

  async start() {
    if (this.running) return;
    try { this.state = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") this.logger.warn?.("[events] resetting unreadable state:", error.message);
      this.state = { cursor: { since: utcNow(), after: "" }, pending: [], notices: [], seen: [] };
      await this.#save();
    }
    if (!this.state?.cursor?.since || !Array.isArray(this.state.pending) ||
        !Array.isArray(this.state.notices)) {
      this.logger.warn?.("[events] resetting invalid saved state");
      this.state = { cursor: { since: utcNow(), after: "" }, pending: [], notices: [], seen: [] };
      await this.#save();
    }
    if (!Array.isArray(this.state.seen)) this.state.seen = [];
    this.running = true;
    void this.tick();
  }

  async close() {
    this.running = false;
    clearTimeout(this.timer);
    while (this.polling) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.state) await this.#save();
  }

  async tick() {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      for (let page = 0; page < 3; page += 1) {
        const result = await this.client.turnUpdates(this.state.cursor);
        for (const turn of result.turns) await this.#consume(turn);
        if (result.next) this.state.cursor = result.next;
        if (result.turns.length) await this.#save();
        if (!result.has_more) break;
      }
      await this.#matureFailures();
      await this.dependencies?.reconcile();
      await this.#flush();
      await this.#save();
    } catch (error) {
      this.logger.warn?.("[events] poll:", error.message);
    } finally {
      this.polling = false;
      if (this.running) {
        this.timer = setTimeout(() => { void this.tick(); }, this.intervalMs);
        this.timer.unref?.();
      }
    }
  }

  async #consume(turn) {
    // A fresh turn on the same thread within the grace period usually means
    // the earlier parked turn was interrupted and replaced, not a blocker.
    if (turn.state === "running" || turn.state === "accepted") {
      this.state.pending = this.state.pending.filter(p => p.threadId !== turn.thread_id);
    }
    if (turn.state === "accepted") {
      this.#notice(`${turn.turn_key}:accepted`, turn.thread_id, "finished");
      await this.dependencies?.accepted(turn.thread_id);
    }
    else if (turn.parked || turn.state === "expired") {
      // The same logical turn can move from parked to expired. Keep one notice.
      const id = `${turn.turn_key}:failure`;
      if (!this.state.seen.includes(id) && !this.state.pending.some(p => p.id === id)) {
        this.state.pending.push({ id, threadId: turn.thread_id, due: this.now() + 5_000 });
      }
    }
  }

  async #matureFailures() {
    const future = [];
    for (const item of this.state.pending) {
      if (item.due <= this.now()) {
        this.#notice(item.id, item.threadId, "stopped or failed");
        await this.dependencies?.failed(item.threadId);
      }
      else future.push(item);
    }
    this.state.pending = future;
  }

  #notice(id, threadId, kind) {
    if (this.state.seen.includes(id)) return;
    this.state.seen.push(id);
    this.state.seen = this.state.seen.slice(-1_000);
    this.state.notices.push({ id, threadId, kind, at: this.now() });
    // Persist a bounded catch-up. The cursor prevents old turns from returning.
    this.state.notices = this.state.notices.slice(-30);
  }

  async #flush() {
    if (!this.state.notices.length || !this.presence.inPresence || !this.presence.joined ||
        this.presence.paused || this.conversation.mode !== "conversation") return;
    if (this.conversation.turn || this.conversation.reply) return;
    const ready = this.state.notices.filter(n => n.kind !== "finished" ||
      this.now() - n.at >= 2_000).slice(0, 6);
    if (!ready.length) return;
    const sessions = await this.client.snapshot();
    const label = id => {
      const session = sessions.find(s => s.threadId === id);
      return session?.tag || session?.name || "A session";
    };
    const failures = ready.filter(n => n.kind !== "finished");
    const finishes = ready.filter(n => n.kind === "finished");
    const parts = [];
    if (failures.length) parts.push(`${failures.slice(0, 3).map(n => label(n.threadId)).join(", ")} stopped or may need attention.`);
    if (finishes.length) parts.push(`${finishes.slice(0, 3).map(n => label(n.threadId)).join(", ")} finished a turn.`);
    const spoken = parts.join(" ");
    if (this.conversation.announce(spoken)) {
      const delivered = new Set(ready.map(n => n.id));
      this.state.notices = this.state.notices.filter(n => !delivered.has(n.id));
    }
  }

  async #save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.file);
  }
}
