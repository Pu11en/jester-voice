import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** Durable identity for an owner action before its EBI POST. */
export class ActionJournal {
  constructor({ file = join(homedir(), ".local/share/jester-voice/actions.json"),
    now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.items = [];
    this.saving = Promise.resolve();
  }

  async start() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(parsed) || parsed.some(item => !item.id || !item.key || !item.kind)) {
        throw new Error("invalid action journal");
      }
      this.items = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.items = [];
      await this.#save();
    }
  }

  async close() { await this.saving; }

  async prepare(kind, target, payload) {
    if (!["spoken", "spawn"].includes(kind) || !target || !payload) throw new Error("Invalid action");
    const key = createHash("sha256").update(JSON.stringify({ kind, target, payload })).digest("hex");
    const existing = this.items.find(item => item.key === key && item.status !== "canceled" &&
      (item.status === "pending" || this.now() - item.createdAt < 300_000));
    if (existing) return { item: existing, fresh: false };
    const item = { id: randomUUID(), key, kind, target, createdAt: this.now(), status: "pending" };
    this.items.push(item);
    await this.#save();
    return { item, fresh: true };
  }

  async finish(item, status, result = null) {
    if (!["posted", "failed", "created", "canceled"].includes(status)) throw new Error("Invalid action result");
    const current = this.items.find(row => row.id === item.id);
    if (!current) throw new Error("Unknown action identity");
    current.status = status;
    current.result = result;
    await this.#save();
  }

  async #save() {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.items), { mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.saving;
  }
}
