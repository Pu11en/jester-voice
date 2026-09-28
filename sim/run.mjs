import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Conversation } from "../src/conversation.mjs";
import { OwnerRouter } from "../src/owner-router.mjs";
import { Presence } from "../src/presence.mjs";
import { scenarios } from "./scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "488763953397235712";
const ids = { zoro: "1553779983158349925", franky: "1553899450227757156", sanji: "1554149594718281869" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(scenarioId) {
  const writes = [];
  const watches = [];
  const groups = [];
  const rows = [
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
  };
  return { client, writes, watches, groups };
}

function makeParts(fixtureState) {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.send = message => {
    worker.sent.push(message);
    if (message.op === "say") setImmediate(() => {
      worker.emit("event", { ev: "say_done", id: message.id });
      voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    });
  };
  worker.dropQueuedAudio = () => {};
  const brain = new EventEmitter();
  brain.asks = [];
  brain.context = [];
  brain.ask = async function* (text) {
    this.asks.push(text);
    const context = this.context.splice(0).join(" ");
    if (/Verified EBI session context:.*zoro/i.test(context)) {
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
    play() {}, stopNow() {}, playedMs() { return 60_000; },
    displayName(id) { return id === "guest" ? "Guest" : "Drew"; },
  });
  const transcript = { record: async () => {}, finish: async () => {}, setMode: () => {} };
  const dependencies = {
    async addResultWatch(item) { fixtureState.watches.push(item); },
    async addGroup(item) { fixtureState.groups.push(item); },
    async cancelPending() {},
  };
  const ownerRouter = new OwnerRouter({ client: fixtureState.client, ownerId, dependencies });
  const presence = new Presence({ client: new EventEmitter(), voice, brain, transcript,
    config: { ownerId, guildId: "guild", voiceChannelId: "room", transcriptChannelId: "transcript" },
    logger: { warn() {} } });
  const conversation = new Conversation({ worker, brain, voice, ownerId, presence, transcript, ownerRouter,
    logFile: resolve(root, "sim/results/turns.jsonl"), logger: { warn() {} } });
  return { worker, brain, voice, presence, conversation };
}

export function grade(expect, actual) {
  const failures = [];
  if (expect.silence && actual.speech.length) failures.push(`Spoke: ${actual.speech.join(" | ")}`);
  for (const term of expect.says || []) {
    if (!actual.speech.join(" ").toLowerCase().includes(term.toLowerCase())) failures.push(`Speech omitted “${term}”`);
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

async function runScenario(scenario) {
  const fixtureState = fixture(scenario.id);
  const parts = makeParts(fixtureState);
  const { worker, brain, voice, conversation } = parts;
  conversation.start();
  const steps = [];
  try {
    await sleep(10);
    for (const step of scenario.steps) {
      const before = { sent: worker.sent.length, writes: fixtureState.writes.length,
        watches: fixtureState.watches.length, groups: fixtureState.groups.length,
        brain: brain.asks.length, disconnects: voice.disconnects };
      worker.emit("event", { ev: "turn_end", speaker: step.speaker === "owner" ? ownerId : "guest",
        text: step.text, ms: { stt: 100, utterance: 1000 } });
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
        disconnected: voice.disconnects > before.disconnects,
      };
      steps.push({ speaker: step.speaker, text: step.text, expected: step.expect,
        actual, failures: grade(step.expect, actual) });
    }
  } finally {
    await conversation.close();
  }
  return { id: scenario.id, title: scenario.title, steps,
    passed: steps.every(step => !step.failures.length) };
}

export async function runAll() {
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));
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
