import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Conversation } from "../src/conversation.mjs";
import { OwnerRouter } from "../src/owner-router.mjs";
import { Presence } from "../src/presence.mjs";
import { scenarios } from "./scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "488763953397235712";
const ids = { zoro: "1553779983158349925", franky: "1553899450227757156", sanji: "1554149594718281869" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EVENTS = new Set(["speech_start", "pause", "turn_end", "speech_sustained"]);
const SCENARIO_KEYS = new Set(["id", "title", "steps", "holdPlayback", "brainFailure", "rows"]);
const STEP_KEYS = new Set(["speaker", "text", "events", "release", "expect"]);
const EXPECT_KEYS = new Set(["silence", "says", "saysNot", "writes", "watches", "groups", "brain",
  "brainAnswers", "writeKind", "writeTarget", "writeThreadId", "writeText", "writeExcludes", "muted",
  "disconnected", "stops", "stopOn", "transcriptOmits"]);

/** Problems with a scenario's shape; an empty list means the runner can play it. */
export function validateScenario(scenario) {
  const problems = [];
  const where = scenario?.id || "(no id)";
  if (typeof scenario?.id !== "string" || !scenario.id) problems.push("scenario needs an id");
  if (typeof scenario?.title !== "string" || !scenario.title) problems.push(`${where}: needs a title`);
  for (const key of Object.keys(scenario || {})) {
    if (!SCENARIO_KEYS.has(key)) problems.push(`${where}: unknown scenario key ${key}`);
  }
  if (scenario?.rows !== undefined && (!Array.isArray(scenario.rows) ||
      scenario.rows.some(row => typeof row.threadId !== "string" || !/^\d{17,20}$/.test(row.threadId)))) {
    problems.push(`${where}: rows need string snowflake thread IDs`);
  }
  if (!Array.isArray(scenario?.steps) || !scenario.steps.length) {
    problems.push(`${where}: needs at least one step`);
    return problems;
  }
  scenario.steps.forEach((step, index) => {
    const at = `${where} step ${index + 1}`;
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) problems.push(`${at}: unknown step key ${key}`);
    if (!["owner", "guest"].includes(step.speaker)) problems.push(`${at}: speaker must be owner or guest`);
    if (step.events === undefined && typeof step.text !== "string") problems.push(`${at}: needs text or events`);
    if (step.events !== undefined) {
      if (!Array.isArray(step.events) || !step.events.length) problems.push(`${at}: events must be a non-empty list`);
      else for (const event of step.events) {
        if (!EVENTS.has(event?.ev)) problems.push(`${at}: unknown event ${event?.ev}`);
        if (["pause", "turn_end"].includes(event?.ev) && typeof (event.text ?? step.text) !== "string") {
          problems.push(`${at}: ${event.ev} needs text`);
        }
      }
    }
    if (!step.expect || typeof step.expect !== "object") problems.push(`${at}: needs an expect object`);
    else for (const key of Object.keys(step.expect)) {
      if (!EXPECT_KEYS.has(key)) problems.push(`${at}: unknown expectation ${key}`);
    }
  });
  return problems;
}

function fixture(scenario) {
  const scenarioId = scenario.id;
  const writes = [];
  const watches = [];
  const groups = [];
  const rows = scenario.rows ? scenario.rows.map(row => ({ aliases: [], currentTask: "", state: "history",
    closed: false, visible: true, ...row })) : [
    { threadId: ids.zoro, tag: "zoro", name: "Drew's Audit", project: "Drew's Audit",
      currentTask: "", state: "history", closed: false, aliases: [] },
    { threadId: ids.franky, tag: "franky", name: "Franky", project: "Site",
      currentTask: "Checking login", state: "running", closed: false, aliases: ["frankie"] },
    { threadId: ids.sanji, tag: "sanji", name: "Sanji", project: "Site",
      currentTask: "Checking links", state: "running", closed: false, aliases: [] },
  ];
  if (scenarioId === "status-watch") rows[0].state = "running";
  const client = {
    async snapshot() { return rows.map(row => ({ ...row })); },
    async resolveTag(name) {
      const value = String(name).toLowerCase();
      const matches = rows.filter(row => !row.closed && (row.tag === value || row.aliases.includes(value)));
      return matches.length === 1 ? { kind: "found", session: { ...matches[0] } } :
        matches.length ? { kind: "ambiguous", matches } : { kind: "unknown" };
    },
    async threadMessages(threadId) {
      if (threadId !== ids.zoro) return [];
      return [{ is_bot: true, content: "Reviewed the audit landing page and listed three issues. No files changed.",
        created_at: "2026-09-28T18:00:00Z" }];
    },
    async resolveProject(name) {
      if (scenarioId === "create-error") throw new Error("simulated project lookup failure");
      return name.toLowerCase() === "jobs" ?
        { kind: "local_available", locally_verified: true, path: "/projects/Jobs", name: "Jobs" } :
        { kind: "no_match" };
    },
    async spawnSession(payload) {
      writes.push({ kind: "spawn", target: "Jobs", threadId: "1555000000000000001",
        text: payload.instruction, payload });
      return { thread_id: "1555000000000000001", voice_label: "luffy", status: "queued" };
    },
    async sendSpoken(payload) {
      writes.push({ kind: "spoken", target: Object.keys(ids).find(key => ids[key] === payload.threadId),
        threadId: payload.threadId, text: payload.text, payload });
      return { request_id: "sim-request-1", status: "posted" };
    },
    async spokenReceipt() { return { request_id: "sim-request-1", status: "posted" }; },
    async searchSessions() { return []; },
    async stopTurn(threadId) {
      writes.push({ kind: "stop", target: rows.find(row => row.threadId === threadId)?.tag, threadId, text: "" });
      return { status: "stopped" };
    },
    async closeSession(threadId) {
      writes.push({ kind: "close", target: rows.find(row => row.threadId === threadId)?.tag, threadId, text: "" });
      return { status: "closed" };
    },
  };
  return { client, writes, watches, groups };
}

function makeParts(fixtureState, scenario, stateDirectory) {
  const scenarioId = scenario.id;
  const worker = new EventEmitter();
  worker.sent = [];
  // A held reply keeps "playing" until a step releases it, so owner noises
  // arrive while Jester is still talking.
  worker.held = scenario.holdPlayback ? [] : null;
  const finishSay = id => setImmediate(() => {
    worker.emit("event", { ev: "say_done", id });
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
  });
  worker.release = () => {
    const held = worker.held || [];
    worker.held = null;
    for (const id of held) finishSay(id);
  };
  worker.send = message => {
    worker.sent.push(message);
    if (message.op !== "say") return;
    if (worker.held) worker.held.push(message.id);
    else finishSay(message.id);
  };
  worker.dropQueuedAudio = () => {};
  const brain = new EventEmitter();
  brain.asks = [];
  brain.answers = [];
  brain.context = [];
  brain.ask = async function* (text, options = {}) {
    this.asks.push(text);
    if (scenario.brainFailure) {
      // Same shape as FallbackBrain: both brains failed before the first word.
      throw Object.assign(new Error(`simulated Luna failure: ${scenario.brainFailure}`),
        { reason: scenario.brainFailure, brain: "codex" });
    }
    this.answers.push(text);
    if (/in detail/i.test(text)) {
      yield "The audit covers the landing page. ";
      yield "It lists three issues with the header. ";
      yield "The last issue is the slow footer.";
      return;
    }
    const context = `${this.context.splice(0).join(" ")} ${options.context || ""}`;
    if (/Session:\s*zoro/i.test(context)) {
      yield "Zoro reviewed the Drew's Audit landing page; we can discuss the audit next.";
    }
    else if (/hello/i.test(text)) yield "Hello.";
    else yield "I can help, but what kind of audit is it?";
  };
  brain.interrupt = async () => {};
  brain.injectContext = value => { brain.context.push(value); };
  const voice = Object.assign(new EventEmitter(), {
    player: new EventEmitter(), muted: [], disconnects: 0,
    setSelfMuted(value) { this.muted.push(value); },
    disconnect() { this.disconnects += 1; },
    stops: 0,
    play() {}, stopNow() { this.stops += 1; }, playedMs() { return 60_000; },
    displayName(id) { return id === "guest" ? "Guest" : "Drew"; },
  });
  const transcript = { lines: [], async record(name, text) { this.lines.push(`${name}: ${text}`); },
    finish: async () => {}, setMode: () => {} };
  const dependencies = {
    async addResultWatch(item) { fixtureState.watches.push(item); },
    async addGroup(item) { fixtureState.groups.push(item); },
    async cancelPending() {},
  };
  const ownerRouter = new OwnerRouter({ client: fixtureState.client, ownerId, dependencies });
  const intentProposer = scenarioId === "natural-assignment" ? {
    likelyWork: text => /could you put this in zoro/iu.test(text),
    async propose() { return { kind: "message", target: "zoro",
      instruction: "review login and don't edit files" }; },
    async interrupt() {},
  } : null;
  const presence = new Presence({ client: new EventEmitter(), voice, brain, transcript,
    config: { ownerId, guildId: "guild", voiceChannelId: "room", transcriptChannelId: "transcript" },
    stateFile: join(stateDirectory, "presence.json"),
    privacyFile: join(stateDirectory, "privacy.json"),
    logger: { warn() {} } });
  const conversation = new Conversation({ worker, brain, voice, ownerId, presence, transcript,
    ownerRouter, intentProposer,
    logFile: resolve(root, "sim/results/turns.jsonl"), logger: { warn() {} } });
  return { worker, brain, voice, presence, conversation, transcript };
}

export function grade(expect, actual) {
  const failures = [];
  if (expect.silence && actual.speech.length) failures.push(`Spoke: ${actual.speech.join(" | ")}`);
  for (const term of expect.says || []) {
    if (!actual.speech.join(" ").toLowerCase().includes(term.toLowerCase())) failures.push(`Speech omitted “${term}”`);
  }
  for (const term of expect.saysNot || []) {
    if (actual.speech.join(" ").toLowerCase().includes(term.toLowerCase())) failures.push(`Speech included “${term}”`);
  }
  if (expect.brainAnswers !== undefined && actual.brainAnswers !== expect.brainAnswers) {
    failures.push(`Expected ${expect.brainAnswers} Luna answers, got ${actual.brainAnswers}`);
  }
  if (expect.stops !== undefined && actual.stops !== expect.stops) {
    failures.push(`Expected ${expect.stops} playback stops, got ${actual.stops}`);
  }
  if (expect.stopOn && !actual.stopEvents?.includes(expect.stopOn)) {
    failures.push(`Playback did not stop within the ${expect.stopOn} event`);
  }
  for (const term of expect.transcriptOmits || []) {
    if ((actual.transcript || []).join(" ").toLowerCase().includes(term.toLowerCase())) {
      failures.push(`Room transcript recorded “${term}”`);
    }
  }
  if (expect.writes !== undefined && actual.writes.length !== expect.writes) {
    failures.push(`Expected ${expect.writes} EBI writes, got ${actual.writes.length}`);
  }
  if (expect.watches !== undefined && actual.watches.length !== expect.watches) {
    failures.push(`Expected ${expect.watches} result watches, got ${actual.watches.length}`);
  }
  if (expect.groups !== undefined && actual.groups.length !== expect.groups) {
    failures.push(`Expected ${expect.groups} group handoffs, got ${actual.groups.length}`);
  }
  if (expect.brain !== undefined && actual.brain.length !== expect.brain) {
    failures.push(`Expected ${expect.brain} Luna calls, got ${actual.brain.length}`);
  }
  if (expect.writeKind && actual.writes.at(-1)?.kind !== expect.writeKind) failures.push(`Wrong EBI action kind`);
  if (expect.writeTarget && actual.writes.at(-1)?.target !== expect.writeTarget) failures.push(`Wrong EBI target`);
  if (expect.writeThreadId && actual.writes.at(-1)?.threadId !== expect.writeThreadId) failures.push(`Wrong EBI thread ID`);
  for (const term of expect.writeText || []) {
    if (!actual.writes.at(-1)?.text?.toLowerCase().includes(term.toLowerCase())) failures.push(`Task omitted “${term}”`);
  }
  for (const term of expect.writeExcludes || []) {
    if (actual.writes.at(-1)?.text?.toLowerCase().includes(term.toLowerCase())) failures.push(`Task retained superseded “${term}”`);
  }
  if (expect.muted !== undefined && actual.muted !== expect.muted) failures.push(`Expected Discord mute=${expect.muted}`);
  if (expect.disconnected && !actual.disconnected) failures.push("Did not disconnect");
  return failures;
}

async function runScenario(scenario, stateDirectory) {
  const fixtureState = fixture(scenario);
  const parts = makeParts(fixtureState, scenario, stateDirectory);
  const { worker, brain, voice, conversation, transcript } = parts;
  conversation.start();
  const steps = [];
  try {
    await sleep(10);
    for (const step of scenario.steps) {
      const before = { sent: worker.sent.length, writes: fixtureState.writes.length,
        watches: fixtureState.watches.length, groups: fixtureState.groups.length,
        brain: brain.asks.length, answers: brain.answers.length, disconnects: voice.disconnects,
        stops: voice.stops, transcript: transcript.lines.length };
      const speaker = step.speaker === "owner" ? ownerId : "guest";
      const stopEvents = [];
      const events = step.events || [{ ev: "turn_end" }];
      for (const [index, item] of events.entries()) {
        if (index) await sleep(30);
        const stopsBefore = voice.stops;
        // A7 worker shape: pause/turn_end carry voiced_ms, vad_mean and stt_logprob.
        const event = item.ev === "speech_start" || item.ev === "speech_sustained" ?
          { speaker, voiced_ms: item.ev === "speech_sustained" ? 1000 : 288, ...item } :
          { speaker, text: step.text, prob: 0.9, voiced_ms: 900, vad_mean: 0.8, stt_logprob: -0.2,
            ms: { stt: 100, utterance: 1000 }, ...item };
        worker.emit("event", event); // Synchronous: a stop inside the handler counts for this event.
        if (voice.stops > stopsBefore) stopEvents.push(item.ev);
      }
      if (step.release) worker.release();
      await sleep(950); // Jester currently waits 800ms before a side effect.
      const actual = {
        speech: worker.sent.slice(before.sent).filter(item => item.op === "say").map(item => item.text),
        writes: fixtureState.writes.slice(before.writes).map(({ kind, target, threadId, text }) =>
          ({ kind, target, threadId, text })),
        watches: fixtureState.watches.slice(before.watches).map(item => item.sources.map(source => source.threadId)),
        groups: fixtureState.groups.slice(before.groups).map(item => ({
          sources: item.sources.map(source => source.threadId), destinationId: item.destinationId, task: item.task,
        })),
        brain: brain.asks.slice(before.brain), muted: voice.muted.at(-1) ?? false,
        brainAnswers: brain.answers.length - before.answers,
        disconnected: voice.disconnects > before.disconnects,
        stops: voice.stops - before.stops, stopEvents,
        transcript: transcript.lines.slice(before.transcript),
      };
      steps.push({ speaker: step.speaker, text: step.text ?? events.map(item => `${item.ev}:${item.text ?? ""}`).join(" "),
        expected: step.expect,
        actual, failures: grade(step.expect, actual) });
    }
  } finally {
    await conversation.close();
  }
  return { id: scenario.id, title: scenario.title, steps,
    passed: steps.every(step => !step.failures.length) };
}

export async function runAll({ cases = scenarios } = {}) {
  const results = [];
  // Fake Discord does not make real filesystem defaults safe. Keep operational
  // state temporary and separate for every run and scenario; retain only reports.
  const stateDirectory = await mkdtemp(join(tmpdir(), "jester-sim-"));
  try {
    for (const [index, scenario] of cases.entries()) {
      results.push(await runScenario(scenario, join(stateDirectory, String(index))));
    }
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
  return { generated_at: new Date().toISOString(), engine: "Conversation + OwnerRouter; fake Discord, Luna, EBI",
    results, passed: results.filter(result => result.passed).length,
    total: results.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runAll();
  const output = resolve(root, "sim/results/latest.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed}/${report.total} scenarios passed; report: ${output}`);
  for (const item of report.results) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.steps.filter(step => step.failures.length).length} failing turns`);
  if (report.passed !== report.total) process.exitCode = 1;
}
