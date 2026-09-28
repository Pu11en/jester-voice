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

  async accepted(threadId) {
    for (const item of this.items) {
      if (item.status !== "pending" || item.sourceId !== threadId) continue;
      // Persist dispatching before an external POST. Repeats use this one ID.
      item.status = "dispatching";
      await this.#save();
      await this.#dispatch(item);
    }
  }

  async failed(threadId) {
    let changed = false;
    for (const item of this.items) {
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
      if (item.status === "pending" || item.status === "dispatching") {
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
