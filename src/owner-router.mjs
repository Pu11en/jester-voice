import { parseOwnerIntent } from "./owner-intent.mjs";
import { SessionReader } from "./session-reader.mjs";

const PRONOUNS = new Set(["him", "her", "them", "it", "that one", "that session"]);
const BIND_MS = 60_000;
/** EBI's spoken tag vocabulary size (claude_discord/voice_labels.py SPOKEN_LABELS). */
const TAG_WORDS = 10;
const LIST_MAX = 10;
const MATCH_MIN = 0.85;
const NEAR_TIE = 0.03;
/** Spoken only for a detected brain failure with a reason, never for a misparse. */
export const BRAIN_OUT_LINE = "Luna is out until October 4. I can still list, find, send, stop and close sessions.";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isOpen = row => row.closed !== true;
const folder = project => String(project || "").split("/").filter(Boolean).at(-1) || "";
const displayName = row => String(row.name || "").trim() || folder(row.project);
const spokenState = state => (!state || state === "history") ? "idle" : String(state);
const compact = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const tagPhrase = (row, capital = false) => row.tag ? `${capital ? "Tag" : "tag"} ${row.tag}` : `${capital ? "No" : "no"} tag`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const OTHER_MAX = 6;
/** A Discord thread name for speech: no leading "[tag] " and no leading emoji like "📂 ". */
const threadSpoken = name => String(name || "").replace(/^\s*\[[^\]]*\]\s*/u, "")
  .replace(/^[^\p{L}\p{N}]+/u, "").trim();
const runner = thread => thread.ownerName || "someone else";
const andJoin = items => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const foreignRows = threads => threads.map(thread => ({ tag: "", aliases: [], name: threadSpoken(thread.name),
  project: "", thread }));
const cannotSee = thread => `but ${runner(thread)} runs it, so I can't see its work or send it tasks.`;

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array(a.length).fill(false);
  const matchedB = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j += 1) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = matchedB[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function similarity(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (Math.min(query.length, candidate.length) < 4) return 0;
  if (candidate.includes(query) || query.includes(candidate)) return 0.92;
  return jaroWinkler(query, candidate);
}

/** Best similarity of a spoken name against a row's tag, aliases, thread name and project folder. */
function rowScore(row, query) {
  const names = [row.tag, ...(row.aliases || []), row.name, folder(row.project)].map(compact).filter(Boolean);
  return Math.max(0, ...names.map(name => similarity(query, name)));
}

/** Resolve a spoken name to one clear best row; a near tie is ambiguous, never a guess. */
export function matchSession(rows, spoken) {
  const query = compact(spoken);
  if (!query) return { kind: "unknown", closest: null };
  const scored = rows.map(row => ({ row, score: rowScore(row, query) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { kind: "unknown", closest: null };
  const [best, second] = scored;
  if (best.score < MATCH_MIN) return { kind: "unknown", closest: best.score >= 0.7 ? best.row : null };
  if (second && second.score >= best.score - NEAR_TIE) {
    return { kind: "ambiguous", matches: scored.filter(item => item.score >= best.score - NEAR_TIE).map(item => item.row) };
  }
  return { kind: "found", session: best.row };
}

/** Every open row whose tag, alias, name or project folder matches the spoken words. */
export function searchRows(rows, spoken) {
  const query = compact(spoken);
  if (!query) return [];
  return rows.map(row => ({ row, score: rowScore(row, query) })).filter(item => item.score >= MATCH_MIN)
    .sort((a, b) => b.score - a.score).map(item => item.row);
}

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
    dependencies = null, actionJournal = null, tagWords = TAG_WORDS,
    sessionReader = new SessionReader({ client }) }) {
    this.client = client;
    this.ownerId = String(ownerId);
    this.now = now;
    this.postLink = postLink;
    this.tagWords = tagWords;
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

  /** The deterministic status line for status-one, status-last and session-discuss; no brain needed. */
  async statusSentence(intent, { allowReference = false } = {}) {
    const resolved = await this.#target(intent.target, allowReference);
    if (resolved.kind === "ambiguous") return `More than one session matches ${intent.target}. Please name the exact one.`;
    if (resolved.kind !== "found") return `I can't find an open session named ${intent.target}.`;
    return this.#describe(resolved.session);
  }

  async #describe(session) {
    const name = session.tag || session.name || "that session";
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

  /** Active Discord threads other bots or people run; EBI may not send them yet. */
  #others() { return Array.isArray(this.client.otherThreads) ? this.client.otherThreads : []; }

  #otherSentence(others) {
    const groups = new Map();
    for (const thread of others.slice(0, OTHER_MAX)) {
      const key = thread.ownerId || thread.ownerName || "";
      if (!groups.has(key)) groups.set(key, { owner: runner(thread), names: [] });
      groups.get(key).names.push(threadSpoken(thread.name) || "an unnamed thread");
    }
    const parts = [...groups.values()].map(group => `${andJoin(group.names)} by ${group.owner}`);
    if (others.length > OTHER_MAX) parts.push(`and ${others.length - OTHER_MAX} more`);
    return `Also open in Discord, run by other bots: ${parts.join("; ")}.`;
  }

  #listOpen(rows, others = []) {
    const also = others.length ? ` ${this.#otherSentence(others)}` : "";
    const open = rows.filter(isOpen);
    if (!open.length) return also ? `No EBI sessions are open right now.${also}` : "No sessions are open right now.";
    const named = open.filter(row => displayName(row));
    const parts = named.slice(0, LIST_MAX).map(row =>
      `${displayName(row)} (${tagPhrase(row)}, ${spokenState(row.state)})`);
    if (named.length > LIST_MAX) parts.push(`and ${named.length - LIST_MAX} more with names`);
    if (open.length > named.length) parts.push(`and ${open.length - named.length} more without names`);
    const hidden = open.filter(row => row.visible === false).length;
    const visibility = hidden ? ` ${hidden} of them ${hidden === 1 ? "isn't" : "aren't"} visible in Discord.` : "";
    return `${plural(open.length, "open session")}: ${parts.join("; ")}.${visibility}${also}`;
  }

  #whyNoTag(rows, target) {
    const open = rows.filter(isOpen);
    const holders = open.filter(row => row.tag);
    const untagged = open.filter(row => !row.tag);
    let lead = "";
    if (target) {
      const match = matchSession(open, target);
      if (match.kind === "found") {
        const row = match.session;
        if (row.tag) return `${displayName(row) || target} does have a tag: ${row.tag}.`;
        lead = `${displayName(row) || target} has no tag. `;
      } else if (match.kind === "ambiguous") {
        lead = `More than one open session matches ${target}. `;
      } else {
        lead = `I don't see an open session called ${target}. `;
      }
    }
    const held = holders.slice(0, 6).map(row => `${row.tag} for ${displayName(row) || "an unnamed thread"}`);
    if (holders.length > 6) held.push(`and ${holders.length - 6} more`);
    const free = Math.max(0, this.tagWords - holders.length);
    let words;
    if (!holders.length) words = `None of the ${this.tagWords} voice words are held.`;
    else if (!free) words = `All ${this.tagWords} voice words are held: ${held.join(", ")}.`;
    else words = `${holders.length} of ${this.tagWords} voice words ${holders.length === 1 ? "is" : "are"} held: ${held.join(", ")}. ` +
      `${plural(free, "word")} ${free === 1 ? "is" : "are"} free, so EBI did not run out of tags.`;
    const untaggedNames = untagged.map(displayName).filter(Boolean).slice(0, 3);
    let missing;
    if (!untagged.length) missing = "Every open session has a tag.";
    else {
      const examples = untaggedNames.length ? (untaggedNames.length === untagged.length ? `: ${untaggedNames.join(", ")}` :
        `, including ${untaggedNames.join(", ")}`) : "";
      missing = `${plural(untagged.length, "open session")} ${untagged.length === 1 ? "has" : "have"} no tag${examples}.`;
    }
    const remedy = free ? "" : " Closing a session frees its word.";
    return `${lead}${words} ${missing}${remedy}`;
  }

  async #seeOne(target, allowReference) {
    const rows = await this.client.snapshot();
    if (PRONOUNS.has(target.toLowerCase())) {
      const resolved = await this.#target(target, allowReference);
      if (resolved.kind !== "found") return "Which session do you mean?";
      return this.#yes(resolved.session);
    }
    const match = matchSession(rows.filter(isOpen), target);
    if (match.kind === "found") return this.#yes(match.session);
    if (match.kind === "ambiguous") {
      return `More than one open session matches ${target}: ${match.matches.slice(0, 4).map(row => displayName(row) || row.tag).join(", ")}.`;
    }
    const closed = matchSession(rows.filter(row => !isOpen(row)), target);
    if (closed.kind === "found") return `No, ${displayName(closed.session) || target} is closed.`;
    const other = matchSession(foreignRows(this.#others()), target);
    if (other.kind === "found") {
      return `Yes, ${other.session.name || target} is open in Discord, ${cannotSee(other.session.thread)}`;
    }
    if (match.closest) return `No, I don't see ${target} open. The closest open one is ${displayName(match.closest) || match.closest.tag}.`;
    return `No, I don't see an open session called ${target}.`;
  }

  #yes(row) {
    this.bound = { threadId: row.threadId, until: this.now() + BIND_MS };
    return `Yes, ${displayName(row) || row.tag} is open. ${tagPhrase(row, true)}, ${spokenState(row.state)}.`;
  }

  async handle(text, { speakerId, allowReference = false, shouldAct = () => true,
    intent: suppliedIntent = null } = {}) {
    if (String(speakerId) !== this.ownerId) return null;
    const intent = suppliedIntent || parseOwnerIntent(text);
    if (!intent) return null;
    if (intent.kind === "clarify") {
      if (intent.reason === "hold") return "Okay, I won't send anything. Say the task again when you're ready.";
      if (intent.reason === "proposal-unavailable") return BRAIN_OUT_LINE;
      return "Please say the final task once more so I send the right words.";
    }
    if (intent.kind === "list-open") {
      const rows = await this.client.snapshot();
      return this.#listOpen(rows, this.#others());
    }
    if (intent.kind === "why-no-tag") return this.#whyNoTag(await this.client.snapshot(), intent.target);
    if (intent.kind === "see-one") return this.#seeOne(intent.target, allowReference);
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
      // Open rows first, by name or project; closed-thread search is deferred.
      const open = (await this.client.snapshot()).filter(isOpen);
      const rows = searchRows(open, intent.query);
      if (rows.length === 1) {
        this.bound = { threadId: rows[0].threadId, until: this.now() + BIND_MS };
        return `I found ${displayName(rows[0]) || rows[0].tag}. ${tagPhrase(rows[0], true)}, ${spokenState(rows[0].state)}.`;
      }
      if (rows.length > 1) {
        const names = rows.slice(0, 5).map(row => `${displayName(row) || row.tag} (${tagPhrase(row)}, ${spokenState(row.state)})`);
        return `I found ${rows.length} open sessions matching ${intent.query}: ${names.join("; ")}.`;
      }
      const foreign = searchRows(foreignRows(this.#others()), intent.query);
      if (foreign.length === 1) return `I found ${foreign[0].name || intent.query} in Discord, ${cannotSee(foreign[0].thread)}`;
      if (foreign.length > 1) {
        const names = foreign.slice(0, 5).map(row => `${row.name || "an unnamed thread"} by ${runner(row.thread)}`);
        return `I found ${foreign.length} threads other bots run matching ${intent.query}: ${names.join("; ")}.`;
      }
      if (!this.client.searchSessions) return `I couldn't find an open session about ${intent.query}.`;
      let found;
      try {
        const openIds = new Set(open.map(row => row.threadId));
        found = (await this.client.searchSessions(intent.query)).filter(item => openIds.has(item.threadId));
      } catch {
        return `I couldn't find an open session about ${intent.query}, and the thread search isn't answering.`;
      }
      if (!found.length) return `I couldn't find an open session about ${intent.query}.`;
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
    if (["status-one", "status-last", "session-discuss"].includes(intent.kind)) return this.#describe(session);
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
    let sentNow = !action || action.fresh;
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
          sentNow = true;
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
    if (receipt.status === "posted") {
      return sentNow ? `I posted your task to ${name}.` :
        `I already posted that task to ${name}, so I didn't send it again.`;
    }
    if (receipt.status === "failed") return `Posting to ${name} failed. Please check the thread before trying again.`;
    return `${name} accepted the task, but I couldn't verify the post yet.`;
  }
}
