import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AttachmentBuilder } from "discord.js";
import { appendBounded } from "./bounded-log.mjs";

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const TRANSCRIPT_HEADER_LINES = 7;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const clock = (date) => date.toISOString().slice(11, 19);

/** One Markdown transcript for each continuous owner voice-room presence. */
export class RoomTranscript {
  constructor({ directory = join(homedir(), ".local/share/drew-ai-voice-transcripts/runtime/transcripts"),
    now = () => new Date(), logger = console, client = null, channelId = null,
    publishIntervalMs = 5_000, retryMs = 10_000 } = {}) {
    this.directory = directory;
    this.now = now;
    this.logger = logger;
    this.client = client;
    this.channelId = channelId;
    this.publishIntervalMs = publishIntervalMs;
    this.retryMs = retryMs;
    this.path = null;
    this.queue = Promise.resolve();
    this.message = null;
    this.publishTimer = null;
    this.publishing = null;
    this.publishDirty = false;
    this.mode = "conversation";
  }

  async start({ channel }) {
    if (this.path) await this.finish();
    await this.prune();
    const started = this.now();
    this.id = randomUUID();
    this.started = started;
    this.path = join(this.directory, `${this.id}.md`);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, [
      "# Voice transcript",
      "",
      `- Session: \`${this.id}\``,
      `- Channel: ${channel || "Unknown"}`,
      `- Started: ${started.toISOString()}`,
      "- Ended: (in progress)",
      "",
    ].join("\n"), "utf8");
    this.queue = Promise.resolve();
    this.message = null;
    this.mode = "conversation";
    this.publishDirty = true;
    this.#schedulePublish(0);
    return this.path;
  }

  record(speaker, text, at = this.now()) {
    if (!this.path || !String(text || "").trim()) return Promise.resolve(false);
    const line = `**${clock(at)} — ${String(speaker || "Unknown").replace(/[\r\n]/g, " ")}:** ${String(text).trim().replace(/[\r\n]+/g, " ")}\n`;
    const path = this.path;
    this.queue = this.queue.then(() => appendBounded(path, line, MAX_TRANSCRIPT_BYTES, TRANSCRIPT_HEADER_LINES)).catch((error) => {
      this.logger.warn?.("[transcript] append:", error.message);
    });
    this.publishDirty = true;
    this.#schedulePublish(this.publishIntervalMs);
    return this.queue.then(() => true);
  }

  setMode(mode) {
    this.mode = mode;
    this.publishDirty = true;
    this.#schedulePublish(0);
  }

  async prune() {
    await mkdir(this.directory, { recursive: true });
    const cutoff = this.now().getTime() - RETENTION_MS;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.md$/i.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      if (path === this.path) continue;
      try {
        if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
      } catch (error) {
        if (error.code !== "ENOENT") this.logger.warn?.("[transcript] prune:", error.message);
      }
    }
  }

  #schedulePublish(delay) {
    if (!this.client || !this.channelId || !this.path || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.#publish();
    }, delay);
    this.publishTimer.unref?.();
  }

  async #publish() {
    if (this.publishing) return;
    const path = this.path;
    if (!path) return;
    this.publishing = (async () => {
      await this.queue;
      this.publishDirty = false;
      await this.#sendSnapshot(path);
    })();
    try { await this.publishing; }
    catch (error) {
      this.logger.warn?.("[transcript] publish:", error.message);
      if (this.path === path) this.#schedulePublish(this.retryMs);
    } finally {
      this.publishing = null;
      if (this.publishDirty && this.path === path) this.#schedulePublish(this.publishIntervalMs);
    }
  }

  async #sendSnapshot(path, ended = false) {
    const channel = this.client.channels?.cache?.get(this.channelId) ||
      await this.client.channels?.fetch?.(this.channelId);
    if (!channel?.send) throw new Error("Auto Transcripts channel unavailable");
    const data = await readFile(path);
    const payload = {
      content: `Jester voice transcript · ${ended ? "Ended" : this.mode === "transcript" ? "Just listening" : "Conversation"}`,
      files: [new AttachmentBuilder(data, { name: `jester-${this.id}.md` })],
    };
    if (this.message) this.message = await this.message.edit({ ...payload, attachments: [] });
    else this.message = await channel.send(payload);
  }

  async finish() {
    if (!this.path) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
    if (this.publishing) await this.publishing.catch(() => {});
    const path = this.path;
    const ended = this.now().toISOString();
    this.path = null;
    await this.queue;
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace(/^- Ended: .*$/m, `- Ended: ${ended}`), "utf8");
    // A failed initial post gets another chance at session close.
    if (this.client && this.channelId) {
      try { await this.#sendSnapshot(path, true); }
      catch (error) { this.logger.warn?.("[transcript] final publish:", error.message); }
    }
  }
}
