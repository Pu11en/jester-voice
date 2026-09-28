import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const clock = (date) => date.toISOString().slice(11, 19);

/** One Markdown transcript for each continuous owner voice-room presence. */
export class RoomTranscript {
  constructor({ directory = join(homedir(), ".local/share/drew-ai-voice-transcripts/runtime/transcripts"),
    now = () => new Date(), logger = console } = {}) {
    this.directory = directory;
    this.now = now;
    this.logger = logger;
    this.path = null;
    this.queue = Promise.resolve();
  }

  async start({ channel }) {
    if (this.path) await this.finish();
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
    return this.path;
  }

  record(speaker, text, at = this.now()) {
    if (!this.path || !String(text || "").trim()) return Promise.resolve(false);
    const line = `**${clock(at)} — ${String(speaker || "Unknown").replace(/[\r\n]/g, " ")}:** ${String(text).trim().replace(/[\r\n]+/g, " ")}\n`;
    const path = this.path;
    this.queue = this.queue.then(() => appendFile(path, line, "utf8")).catch((error) => {
      this.logger.warn?.("[transcript] append:", error.message);
    });
    return this.queue.then(() => true);
  }

  async finish() {
    if (!this.path) return;
    const path = this.path;
    const ended = this.now().toISOString();
    this.path = null;
    await this.queue;
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace(/^- Ended: .*$/m, `- Ended: ${ended}`), "utf8");
  }
}
