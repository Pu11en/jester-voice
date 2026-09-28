import { parseOwnerIntent } from "./owner-intent.mjs";
import { SessionReader } from "./session-reader.mjs";

const PRONOUNS = new Set(["him", "her", "them", "it", "that one", "that session"]);
const BIND_MS = 60_000;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function runtimeChoice(intent) {
  const choice = intent.runtime.toLowerCase();
  const requestedModel = intent.model?.toLowerCase() || null;
  if (choice === "codex" && (!requestedModel || requestedModel === "auto")) {
    return { backend: "codex", model: null };
  }
  if (["claude", "sonnet"].includes(choice) &&
    (!requestedModel || ["sonnet", "opus", "haiku"].includes(requestedModel))) {
    return { backend: "claude", model: requestedModel || "sonnet" };
  }
  if (["deepseek", "dsh"].includes(choice) && !requestedModel) {
    return { backend: "dsh", model: "deepseek-v4-pro" };
  }
  return null;
}

/** Deterministic owner actions; model output never enters this action path. */
export class OwnerRouter {
  constructor({ client, ownerId, now = () => Date.now(), postLink = null,
    dependencies = null, actionJournal = null,
    sessionReader = new SessionReader({ client }) }) {
    this.client = client;
    this.ownerId = String(ownerId);
    this.now = now;
    this.postLink = postLink;
    this.dependencies = dependencies;
    this.actionJournal = actionJournal;
    this.trace = null;
    this.sessionReader = sessionReader;
    this.bound = null;
    this.readBoundUntil = null;
    this.lastGroup = null;
  }

  reset() { this.bound = null; this.readBoundUntil = null; this.lastGroup = null; }

  hasReadContext() { return this.readBoundUntil !== null && this.now() < this.readBoundUntil; }

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

  async #stillTarget(name, session, allowReference) {
    const current = await this.#target(name, allowReference);
    return current.kind === "found" && current.session.threadId === session.threadId;
  }

  async readContext(intent, { allowReference = false } = {}) {
    const resolved = await this.#target(intent.target, allowReference);
    if (resolved.kind === "ambiguous") return { kind: "answer", text: `More than one session matches ${intent.target}. Which one do you mean?` };
    if (resolved.kind !== "found") return { kind: "answer", text: `I can't find an open session named ${intent.target}.` };
    const session = resolved.session;
    this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
    try {
      const text = await this.sessionReader.read(session);
      this.readBoundUntil = this.now() + BIND_MS;
      return { kind: "context", text, threadId: session.threadId };
    } catch {
      return { kind: "answer", text: `I found ${session.tag || session.name || "that session"}, but can't read its work right now.` };
    }
  }

  async handle(text, { speakerId, allowReference = false, shouldAct = () => true,
    intent: suppliedIntent = null } = {}) {
    if (String(speakerId) !== this.ownerId) return null;
    const intent = suppliedIntent || parseOwnerIntent(text);
    if (!intent) return null;
    if (intent.kind === "clarify") return intent.reason === "hold" ?
      "Okay, I won't send anything. Say the task again when you're ready." :
      "Please say the final task once more so I send the right words.";
    if (intent.kind === "status-all") {
      const sessions = (await this.client.snapshot()).filter(s => !s.closed &&
        ["running", "queued"].includes(s.state));
      if (!sessions.length) return "No EBI sessions are running or queued right now.";
      const summary = sessions.slice(0, 5).map(s => {
        const name = s.tag || s.name || "unnamed session";
        const task = s.currentTask?.trim() ? s.currentTask.trim().replace(/\s+/g, " ").slice(0, 80) : "task unavailable";
        return `${name} (${s.state}): ${task}`;
      });
      return `Sessions: ${summary.join("; ")}${sessions.length > 5 ? `; and ${sessions.length - 5} more` : ""}.`;
    }
    if (intent.kind === "history") {
      const found = await this.client.searchSessions(intent.query);
      if (!found.length) return `I couldn't find a session about ${intent.query}.`;
      if (found.length > 1) {
        const names = found.slice(0, 3).map(item => item.name.slice(0, 60) || "unnamed thread");
        return `I found ${found.length} matches: ${names.join("; ")}. Please narrow the topic or project.`;
      }
      const item = found[0];
      if (item.link.startsWith("https://discord.com/channels/") && this.postLink) {
        try {
          await this.postLink(item.name || intent.query, item.link);
          return `I found the ${item.name || intent.query} session and put its link in Auto Transcripts.`;
        } catch { /* The voice answer still tells Drew what was found. */ }
      }
      return `I found the ${item.name || intent.query} session, but couldn't post its link.`;
    }
    if (intent.kind === "result-watch") {
      if (!this.dependencies?.addResultWatch) return "I can't watch session results right now.";
      let sources;
      if (intent.selection === "running") {
        sources = (await this.client.snapshot()).filter(s => !s.closed &&
          ["running", "queued"].includes(s.state)).map(s => ({
          threadId: s.threadId, label: s.tag || s.name || "session",
        }));
      } else {
        const resolved = await Promise.all(intent.targets.map(name => this.client.resolveTag(name)));
        sources = [];
        for (let i = 0; i < intent.targets.length; i += 1) {
          const name = intent.targets[i];
          const found = resolved[i];
          if (found.kind !== "found") return `I couldn't identify ${name} exactly. Please use its current tag.`;
          if (!["running", "queued"].includes(found.session.state)) {
            return `${found.session.tag || name} isn't working on a turn right now.`;
          }
          if (sources.some(s => s.threadId === found.session.threadId)) {
            return "Two names point to the same session. Please name each session once.";
          }
          sources.push({ threadId: found.session.threadId,
            label: found.session.tag || found.session.name || name });
        }
        const still = await Promise.all(sources.map((source, i) =>
          this.#stillTarget(intent.targets[i], { threadId: source.threadId }, false)));
        if (still.some(value => !value)) {
          return "A session tag changed while I was checking. Please say the request again.";
        }
      }
      if (!sources.length) return "No sessions are working on a turn right now.";
      if (sources.length > 100) return "I can watch up to 100 sessions at once. Please name a smaller group.";
      const current = (await this.client.snapshot()).filter(s => !s.closed &&
        ["running", "queued"].includes(s.state));
      const currentIds = new Set(current.map(s => s.threadId));
      if (sources.some(s => !currentIds.has(s.threadId)) ||
          (intent.selection === "running" && currentIds.size !== sources.length)) {
        return "The working sessions changed while I was checking. Please say the request again.";
      }
      if (!shouldAct()) return null;
      await this.dependencies.addResultWatch({ sources });
      this.lastGroup = { sources, until: this.now() + BIND_MS };
      return `I'll watch ${sources.length} ${sources.length === 1 ? "session" : "sessions"} and check their final replies for test steps.`;
    }
    if (intent.kind === "dependency-group") {
      const group = this.lastGroup;
      if (!group || group.sources.length !== 2 || this.now() > group.until) {
        return "Which two sessions do you mean by both?";
      }
      if (!this.dependencies?.addGroup) return "I can't schedule a group follow-on task right now.";
      const destination = await this.client.resolveTag(intent.target);
      if (destination.kind !== "found") return `I couldn't identify ${intent.target} exactly.`;
      const current = (await this.client.snapshot()).filter(s => !s.closed &&
        ["running", "queued"].includes(s.state));
      const currentIds = new Set(current.map(s => s.threadId));
      if (group.sources.some(s => !currentIds.has(s.threadId)) ||
          group.sources.some(s => s.threadId === destination.session.threadId)) {
        return "One of those sessions changed. Please name the two sources again.";
      }
      if (!(await this.#stillTarget(intent.target, destination.session, false))) {
        return "That destination tag changed. Please say the task again.";
      }
      if (!shouldAct()) return null;
      await this.dependencies.addGroup({ sources: group.sources,
        destinationId: destination.session.threadId, task: intent.instruction });
      return `When both finish successfully, I'll send one task to ${destination.session.tag || intent.target}.`;
    }
    if (intent.kind === "dependency") {
      if (!this.dependencies) return "Follow-on tasks are unavailable right now.";
      if (intent.instruction && /\b(?:actually|wait|rather|instead)\b/i.test(intent.instruction)) {
        return "Please say the final follow-on task once more.";
      }
      const source = await this.client.resolveTag(intent.source);
      const destination = await this.client.resolveTag(intent.target);
      if (source.kind !== "found" || destination.kind !== "found") {
        return "I couldn't identify both sessions. Please use their current tags.";
      }
      if (!['running', 'queued'].includes(source.session.state)) {
        return `${source.session.tag || intent.source} isn't working on a turn right now.`;
      }
      if (source.session.threadId === destination.session.threadId) {
        return "Those names point to the same session. Please name two different sessions.";
      }
      if (!(await this.#stillTarget(intent.source, source.session, false)) ||
          !(await this.#stillTarget(intent.target, destination.session, false))) {
        return "One of those tags changed while I was checking. Please say the task again.";
      }
      if (!shouldAct()) return null;
      await this.dependencies.add({ sourceId: source.session.threadId,
        destinationId: destination.session.threadId, task: intent.instruction });
      return `When ${source.session.tag || intent.source} finishes its current turn, I'll send the task to ${destination.session.tag || intent.target}.`;
    }
    if (intent.kind === "create") {
      if (/\b(?:actually|wait|rather|instead)\b/i.test(intent.instruction)) {
        return "Please say the final first task once more before I create the session.";
      }
      const project = await this.client.resolveProject(intent.project);
      if (project.kind !== "local_available" || project.locally_verified !== true || !project.path) {
        return `I couldn't find one available local project named ${intent.project}. Please use its project name.`;
      }
      const choice = intent.runtime ? runtimeChoice(intent) : { backend: "codex", model: null };
      if (!choice) return "I couldn't match that model and agent combination. Please name one supported choice.";
      if (!shouldAct()) return null;
      const action = this.actionJournal ? await this.actionJournal.prepare("spawn", project.path,
        { instruction: intent.instruction || null, empty: intent.empty === true,
          backend: choice.backend, model: choice.model }) : null;
      this.trace?.({ kind: "spawn", stage: "prepared", target: project.path,
        actionId: action?.item.id || null, repeated: action ? !action.fresh : false });
      if (!shouldAct()) {
        if (action?.fresh) await this.actionJournal.finish(action.item, "canceled");
        return null;
      }
      let created;
      try {
        if (action && !action.fresh) {
          created = action.item.status === "created" ? action.item.result :
            await this.client.spawnCorrelation(action.item.id);
        } else {
          created = await this.client.spawnSession({ projectPath: project.path,
            instruction: intent.instruction,
            ...(intent.empty === true ? { empty: true, threadName: project.name } : {}),
            ownerId: this.ownerId, ...choice,
            ...(action ? { correlationId: action.item.id } : {}) });
        }
      } catch {
        this.trace?.({ kind: "spawn", stage: "uncertain", target: project.path,
          actionId: action?.item.id || null });
        return "I couldn't verify whether the session was created. I won't create it twice.";
      }
      if (action) await this.actionJournal.finish(action.item, "created", created);
      this.trace?.({ kind: "spawn", stage: "created", target: created.thread_id,
        actionId: action?.item.id || null, status: created.status });
      this.bound = { threadId: created.thread_id, until: this.now() + BIND_MS };
      const tag = created.voice_label ? `Its tag is ${created.voice_label}.` :
        "I couldn't verify a voice tag for it yet; find the thread in Discord.";
      if (intent.empty === true) {
        return `I created an empty ${choice.backend} session for ${project.name}. ${tag} No task is queued.`;
      }
      const state = ["queued", "running"].includes(created.status) ?
        ` EBI reports the first task is ${created.status}.` :
        " I can't verify that its first task started yet.";
      return `I created a ${choice.backend} session for ${project.name}. ${tag}${state}`;
    }
    const resolved = await this.#target(intent.target, allowReference);
    if (resolved.kind === "ambiguous") return `More than one session matches ${intent.target}. Please name the exact one.`;
    if (resolved.kind !== "found") return `I can't find an open session named ${intent.target}.`;
    const session = resolved.session;
    const name = session.tag || session.name || "that session";
    if (["status-one", "status-last", "session-discuss"].includes(intent.kind)) {
      this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
      const task = session.currentTask ? ` Task: ${session.currentTask.slice(0, 140)}${session.currentTask.length > 140 ? "…" : ""}` : "";
      let recent = "";
      if (this.client.threadMessages) {
        try {
          const messages = await this.client.threadMessages(session.threadId, 12);
          const bots = messages.filter(message => message.is_bot && message.content?.trim());
          const dated = bots.filter(message => Number.isFinite(Date.parse(message.created_at)));
          const last = dated.length ? dated.sort((a, b) =>
            Date.parse(b.created_at) - Date.parse(a.created_at))[0] : bots.at(-1);
          if (last) recent = ` Last reported: ${last.content.trim().replace(/\s+/g, " ").slice(0, 180)}`;
        } catch { /* State still has a truthful, narrower answer. */ }
      }
      const project = session.project ? ` in ${session.project}` : "";
      const state = session.state === "history" ? "not running now" : session.state;
      return `${name} is ${state}${project}.${task}${recent}`;
    }
    if (intent.kind === "stop") {
      if (!(await this.#stillTarget(intent.target, session, allowReference))) {
        return "That tag changed while I was checking. Please say it again.";
      }
      if (!shouldAct()) return null;
      const result = await this.client.stopTurn(session.threadId, this.ownerId);
      this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
      return result.status === "stopped" ? `I stopped ${name}'s current turn.` : `${name} is already idle.`;
    }
    if (intent.kind === "close") {
      if (!(await this.#stillTarget(intent.target, session, allowReference))) {
        return "That tag changed while I was checking. Please say it again.";
      }
      if (!shouldAct()) return null;
      const result = await this.client.closeSession(session.threadId, this.ownerId);
      this.bound = null;
      return result.state === "pending" ? `${name} will close after its current turn.` : `I closed ${name}.`;
    }
    if (intent.kind === "runtime") {
      const choice = runtimeChoice(intent);
      if (!choice) return "I couldn't match that model and agent combination. Please name one supported choice.";
      if (!(await this.#stillTarget(intent.target, session, allowReference))) {
        return "That tag changed while I was checking. Please say it again.";
      }
      if (!shouldAct()) return null;
      await this.client.setRuntime(session.threadId, choice);
      this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
      return choice.model ? `${name} will use ${choice.model} on its next turn.` :
        `${name} will use Codex on its next turn.`;
    }
    if (intent.kind !== "message") return null;
    if (!(await this.#stillTarget(intent.target, session, allowReference))) {
      return "That tag changed while I was checking. Please say the task again.";
    }
    if (!shouldAct()) return null;
    this.bound = { threadId: session.threadId, until: this.now() + BIND_MS };
    const action = this.actionJournal ? await this.actionJournal.prepare("spoken", session.threadId,
      intent.instruction) : null;
    this.trace?.({ kind: "spoken", stage: "prepared", target: session.threadId,
      actionId: action?.item.id || null, repeated: action ? !action.fresh : false });
    if (!shouldAct()) {
      if (action?.fresh) await this.actionJournal.finish(action.item, "canceled");
      return null;
    }
    let receipt;
    try {
      if (action && !action.fresh && ["posted", "failed"].includes(action.item.status)) {
        receipt = action.item.result;
      } else if (action && !action.fresh) {
        try {
          receipt = await this.client.spokenReceipt(session.threadId, action.item.id);
        } catch (error) {
          if (error.status !== 404) throw error;
          // EBI reserves the request ID atomically before delivery. A missing
          // receipt can be retried under that same ID without a second post.
          if (!shouldAct()) return null;
          receipt = await this.client.sendSpoken({ threadId: session.threadId,
            speakerId: this.ownerId, text: intent.instruction, requestId: action.item.id });
        }
      } else {
        receipt = await this.client.sendSpoken({
          threadId: session.threadId, speakerId: this.ownerId, text: intent.instruction,
          ...(action ? { requestId: action.item.id } : {}),
        });
      }
      for (let tries = 0; tries < 15 && receipt.status === "accepted"; tries += 1) {
        await wait(100);
        receipt = await this.client.spokenReceipt(session.threadId, action?.item.id || receipt.request_id);
      }
    } catch {
      this.trace?.({ kind: "spoken", stage: "uncertain", target: session.threadId,
        actionId: action?.item.id || null });
      return `I couldn't verify that ${name} received it. I won't send it twice.`;
    }
    if (action && ["posted", "failed"].includes(receipt.status)) {
      await this.actionJournal.finish(action.item, receipt.status, receipt);
    }
    this.trace?.({ kind: "spoken", stage: receipt.status, target: session.threadId,
      actionId: action?.item.id || receipt.request_id || null });
    if (receipt.status === "posted") return `I posted your task to ${name}.`;
    if (receipt.status === "failed") return `Posting to ${name} failed. Please check the thread before trying again.`;
    return `${name} accepted the task, but I couldn't verify the post yet.`;
  }
}
