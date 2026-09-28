import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** One-time, exact-ID follow-on tasks after checked EBI turn completions. */
export class Dependencies {
  constructor({ client, ownerId, file = join(homedir(), ".local/share/jester-voice/dependencies.json"),
    now = () => Date.now(), logger = console } = {}) {
    this.client = client;
    this.ownerId = String(ownerId);
    this.file = file;
    this.now = now;
    this.logger = logger;
    this.items = [];
    this.saving = Promise.resolve();
  }

  async start() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("invalid dependency state");
      this.items = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") this.logger.warn?.("[dependencies] resetting saved state:", error.message);
      this.items = [];
      await this.#save();
    }
    await this.reconcile();
  }

  async close() { await this.saving; }

  async add({ sourceId, destinationId, task }) {
    if (!/^\d{17,20}$/.test(sourceId) || !/^\d{17,20}$/.test(destinationId) ||
        sourceId === destinationId || !task?.trim() || task.length > 24_000) {
      throw new Error("Invalid follow-on task");
    }
    const item = { id: randomUUID(), sourceId, destinationId, task: task.trim(),
      requestId: randomUUID(), status: "pending", nextRetryAt: 0 };
    this.items.push(item);
    await this.#save();
    return item;
  }

  async addResultWatch({ sources }) {
    if (!Array.isArray(sources) || !sources.length || sources.length > 100 ||
        new Set(sources.map(s => s.threadId)).size !== sources.length ||
        sources.some(s => typeof s.threadId !== "string" ||
          !/^\d{17,20}$/.test(s.threadId) || typeof s.label !== "string" || !s.label.trim())) {
      throw new Error("Invalid result watch targets");
    }
    const requested = sources.map(s => s.threadId).sort().join(",");
    const existing = this.items.find(item => item.kind === "results" &&
      ["pending", "ready"].includes(item.status) &&
      item.sources.map(s => s.threadId).sort().join(",") === requested);
    if (existing) return existing;
    const item = { id: randomUUID(), kind: "results", sources: sources.map(s => ({
      threadId: s.threadId, label: s.label.trim().replace(/\s+/gu, " ").slice(0, 80),
    })), completed: {}, status: "pending", createdAt: new Date(this.now()).toISOString(),
    readyAt: null, reportPosted: false };
    this.items.push(item);
    await this.#save();
    return item;
  }

  async addGroup({ sources, destinationId, task }) {
    if (!Array.isArray(sources) || sources.length < 2 || sources.length > 100 ||
        new Set(sources.map(s => s.threadId)).size !== sources.length ||
        sources.some(s => !/^\d{17,20}$/.test(s.threadId) || s.threadId === destinationId) ||
        !/^\d{17,20}$/.test(destinationId) || !task?.trim() || task.length > 24_000) {
      throw new Error("Invalid group follow-on task");
    }
    const item = { id: randomUUID(), kind: "group", sources: sources.map(s => ({
      threadId: s.threadId, label: String(s.label || "session").slice(0, 80),
    })), destinationId, task: task.trim(), completed: {}, requestId: randomUUID(),
      status: "pending", createdAt: new Date(this.now()).toISOString(), nextRetryAt: 0 };
    this.items.push(item);
    await this.#save();
    return item;
  }

  async accepted(threadId, turn = null) {
    let changed = false;
    const readyGroups = [];
    for (const item of this.items) {
      if (!["results", "group"].includes(item.kind) || item.status !== "pending" ||
          !item.sources.some(s => s.threadId === threadId) || item.completed[threadId]) continue;
      const eventAt = turn?.accepted_at || turn?.updated_at || new Date(this.now()).toISOString();
      if (Date.parse(eventAt) < Date.parse(item.createdAt)) continue;
      item.completed[threadId] = { status: "accepted", at: eventAt };
      if (Object.keys(item.completed).length === item.sources.length) {
        item.status = item.kind === "results" ? "ready" : "dispatching";
        if (item.kind === "results") item.readyAt = this.now();
        else readyGroups.push(item);
      }
      changed = true;
    }
    if (changed) await this.#save();
    for (const item of readyGroups) await this.#dispatch(item);
    for (const item of this.items) {
      if (item.status !== "pending" || item.sourceId !== threadId) continue;
      // Persist dispatching before an external POST. Repeats use this one ID.
      item.status = "dispatching";
      await this.#save();
      await this.#dispatch(item);
    }
  }

  async failed(threadId, turn = null) {
    let changed = false;
    for (const item of this.items) {
      if (item.kind === "results" && item.status === "pending" && turn?.terminal === true &&
          item.sources.some(s => s.threadId === threadId) && !item.completed[threadId]) {
        const eventAt = turn?.updated_at || new Date(this.now()).toISOString();
        if (Date.parse(eventAt) > Date.parse(item.createdAt)) {
          item.completed[threadId] = { status: "failed", at: eventAt };
          if (Object.keys(item.completed).length === item.sources.length) {
            item.status = "ready";
            item.readyAt = this.now();
          }
          changed = true;
        }
      }
      if (item.kind === "group" && item.status === "pending" && turn?.terminal === true &&
          item.sources.some(s => s.threadId === threadId)) {
        item.status = "blocked";
        changed = true;
      }
      if (item.status === "pending" && item.sourceId === threadId) {
        item.status = "blocked";
        changed = true;
      }
    }
    if (changed) await this.#save();
  }

  async cancelPending() {
    let changed = false;
    for (const item of this.items) {
      if (item.status === "pending" || item.status === "dispatching" || item.status === "ready") {
        item.status = "canceled";
        changed = true;
      }
    }
    if (changed) await this.#save();
  }

  async reconcile() {
    for (const item of this.items) {
      if (item.status === "dispatching" && this.now() >= item.nextRetryAt) {
        await this.#dispatch(item);
      }
    }
  }

  readyResultWatches() {
    return this.items.filter(item => item.kind === "results" && item.status === "ready");
  }

  async markReportPosted(id, spoken) {
    const item = this.items.find(item => item.id === id && item.kind === "results");
    if (!item || item.status !== "ready") return false;
    item.reportPosted = true;
    item.reportSpoken = String(spoken || "I posted the watched session results in Auto Transcripts.").slice(0, 1_500);
    await this.#save();
    return true;
  }

  async markReportUnavailable(id) {
    const item = this.items.find(item => item.id === id && item.kind === "results");
    if (!item || item.status !== "ready") return false;
    item.reportUnavailable = true;
    item.reportSpoken = `The ${item.sources.length} watched sessions finished, but I couldn't post their test details. Please check their threads.`;
    await this.#save();
    return true;
  }

  async markResultsDelivered(id) {
    const item = this.items.find(item => item.id === id && item.kind === "results");
    if (!item || item.status !== "ready" || (!item.reportPosted && !item.reportUnavailable)) return false;
    item.status = "delivered";
    await this.#save();
    return true;
  }

  async #dispatch(item) {
    if (item.status !== "dispatching") return;
    try {
      const target = (await this.client.snapshot()).find(s => s.threadId === item.destinationId);
      if (!target || target.closed) {
        item.status = "blocked";
        await this.#save();
        return;
      }
      if (item.status !== "dispatching") return;
      const receipt = await this.client.sendSpoken({ threadId: item.destinationId,
        speakerId: this.ownerId, text: item.task, requestId: item.requestId });
      if (item.status === "dispatching") {
        if (receipt.status === "posted") item.status = "posted";
        else if (receipt.status === "failed") item.status = "blocked";
        else item.nextRetryAt = this.now() + 5_000;
      }
    } catch (error) {
      this.logger.warn?.("[dependencies] delivery uncertain:", error.message);
      if (item.status === "dispatching") item.nextRetryAt = this.now() + 10_000;
    }
    await this.#save();
  }

  async #save() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.items), { mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.saving;
  }
}
