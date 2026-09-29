import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildBrain, buildProposerBrain, startApp } from "./index.mjs";
import { PROPOSER_INSTRUCTIONS } from "./intent-proposer.mjs";
import { Brain } from "./brain.mjs";
import { ClaudeBrain } from "./claude-brain.mjs";
import { FallbackBrain } from "./brain-fallback.mjs";

test("application starts the worker and presence, wires audio, then shuts down cleanly", async () => {
  const calls = [];
  const config = { python: "/fake/python", modelsDir: "/fake/models", ownerId: "owner" };
  const worker = { async start() { calls.push("worker.start"); }, send: (message) => calls.push(["worker.send", message]), async close() { calls.push("worker.close"); } };
  const voice = Object.assign(new EventEmitter(), { client: {}, destroy: async () => calls.push("voice.destroy") });
  const brain = { async close() { calls.push("brain.close"); } };
  const presence = { async start() { calls.push("presence.start"); }, stop() { calls.push("presence.stop"); } };
  const conversation = { start() { calls.push("conversation.start"); }, async close() { calls.push("conversation.close"); } };
  const app = await startApp({ config,
    createWorkerImpl: (options) => { assert.equal(options.command, config.python); return worker; },
    createVoiceImpl: (options) => { options.onAudio("owner", Buffer.from([1, 2])); return voice; },
    createBrainImpl: () => brain,
    createTranscriptImpl: () => ({}),
    createPresenceImpl: () => presence,
    createConversationImpl: (options) => { assert.ok(options.stallClip.length > 0); return conversation; },
    createEventWatcherImpl: () => ({ async start() {}, async close() {} }),
    createDependenciesImpl: () => ({ async start() {}, async close() {} }),
    createActionJournalImpl: () => ({ async start() {}, async close() {} }),
    createIntentProposerImpl: () => ({ async close() {} }),
  });
  await app.start();
  assert.deepEqual(calls.slice(0, 3), [
    ["worker.send", { op: "audio", speaker: "owner", pcm: "AQI=" }],
    "worker.start", "conversation.start",
  ]);
  assert.ok(calls.includes("presence.start"));
  await Promise.all([app.close(), app.close()]);
  assert.deepEqual(calls.slice(-5), ["presence.stop", "conversation.close", "brain.close", "worker.close", "voice.destroy"]);
});

test("startup failure closes constructed services", async () => {
  const calls = [];
  const app = await startApp({ config: { python: "python", modelsDir: "models", ownerId: "owner" },
    createWorkerImpl: () => ({ async start() {}, async close() { calls.push("worker"); }, send() {} }),
    createVoiceImpl: () => ({ client: {}, async destroy() { calls.push("voice"); } }),
    createBrainImpl: () => ({ async close() { calls.push("brain"); } }),
    createTranscriptImpl: () => ({}),
    createPresenceImpl: () => ({ async start() { throw new Error("fake offline login"); }, stop() { calls.push("presence"); } }),
    createConversationImpl: () => ({ start() {}, async close() {} }),
    createEventWatcherImpl: () => ({ async start() {}, async close() {} }),
    createDependenciesImpl: () => ({ async start() {}, async close() {} }),
    createActionJournalImpl: () => ({ async start() {}, async close() {} }),
    createIntentProposerImpl: () => ({ async close() {} }),
  });
  await assert.rejects(app.start(), /fake offline login/);
  assert.deepEqual(calls, ["presence", "brain", "worker", "voice"]);
});

test("buildBrain chains Codex then Claude by default and a plain Codex brain when disabled", async () => {
  const config = { brainFallback: "claude", claudeBin: "/fake/claude", claudeModel: "claude-test",
    brainRetryMinutes: 3 };
  const chained = buildBrain(config, { logger: {} });
  assert.ok(chained instanceof FallbackBrain);
  assert.ok(chained.primary instanceof Brain);
  assert.ok(chained.secondary instanceof ClaudeBrain);
  assert.equal(chained.secondary.command, "/fake/claude");
  assert.equal(chained.secondary.model, "claude-test");
  assert.equal(chained.retryAfterMs, 3 * 60_000);
  assert.deepEqual(chained.names, { primary: "codex", secondary: "claude" });
  assert.equal(buildBrain({}).retryAfterMs, 10 * 60_000, "defaults without config values");
  const plain = buildBrain({ ...config, brainFallback: "none" });
  assert.ok(plain instanceof Brain);
  await Promise.all([chained.close(), plain.close()]);
});

test("the intent proposer gets its own Codex-then-Claude brain, or plain Codex when disabled", async () => {
  const config = { brainFallback: "claude", claudeBin: "/fake/claude", claudeModel: "claude-test",
    brainRetryMinutes: 4 };
  const conversation = buildBrain(config, { logger: {} });
  const chained = buildProposerBrain(config, { logger: {} });
  assert.ok(chained instanceof FallbackBrain);
  assert.ok(chained.primary instanceof Brain);
  assert.ok(chained.secondary instanceof ClaudeBrain);
  assert.notEqual(chained.primary, conversation.primary, "never shares turn state");
  assert.notEqual(chained.secondary, conversation.secondary, "never shares turn state");
  assert.equal(chained.primary.baseInstructions, PROPOSER_INSTRUCTIONS);
  assert.equal(chained.primary.effort, "low");
  assert.equal(chained.secondary.systemPrompt, PROPOSER_INSTRUCTIONS);
  assert.equal(chained.secondary.command, "/fake/claude");
  assert.equal(chained.secondary.model, "claude-test");
  assert.equal(chained.retryAfterMs, 4 * 60_000);
  const plain = buildProposerBrain({ ...config, brainFallback: "none" });
  assert.ok(plain instanceof Brain);
  assert.equal(plain.baseInstructions, PROPOSER_INSTRUCTIONS);
  await Promise.all([conversation.close(), chained.close(), plain.close()]);
});

test("a brainSwitched event is written as one row to the turn log", async () => {
  const rows = [];
  const brain = Object.assign(new EventEmitter(), { async close() {} });
  const app = await startApp({ config: { python: "python", modelsDir: "models", ownerId: "owner" },
    createWorkerImpl: () => ({ async start() {}, async close() {}, send() {} }),
    createVoiceImpl: () => ({ client: {}, async destroy() {} }),
    createBrainImpl: () => brain,
    createTranscriptImpl: () => ({}),
    createPresenceImpl: () => ({ async start() {}, stop() {} }),
    createConversationImpl: () => ({ start() {}, async close() {}, logEvent: row => rows.push(row) }),
    createEventWatcherImpl: () => ({ async start() {}, async close() {} }),
    createDependenciesImpl: () => ({ async start() {}, async close() {} }),
    createActionJournalImpl: () => ({ async start() {}, async close() {} }),
    createIntentProposerImpl: () => ({ async close() {} }),
  });
  brain.emit("brainSwitched", { from: "codex", to: "claude", reason: "usageLimitExceeded" });
  assert.deepEqual(rows, [{ type: "brainSwitched", from: "codex", to: "claude", reason: "usageLimitExceeded" }]);
  await app.close();
  brain.emit("brainSwitched", { from: "claude", to: "codex", reason: "recovered" });
  assert.equal(rows.length, 1, "no rows after close");
});

test("without a public logEvent the row goes through traceRoute with its own type", async () => {
  const rows = [];
  const brain = Object.assign(new EventEmitter(), { async close() {} });
  await startApp({ config: { python: "python", modelsDir: "models", ownerId: "owner" },
    createWorkerImpl: () => ({ async start() {}, async close() {}, send() {} }),
    createVoiceImpl: () => ({ client: {}, async destroy() {} }),
    createBrainImpl: () => brain,
    createTranscriptImpl: () => ({}),
    createPresenceImpl: () => ({ async start() {}, stop() {} }),
    createConversationImpl: () => ({ start() {}, async close() {}, traceRoute: row => rows.push(row) }),
    createEventWatcherImpl: () => ({ async start() {}, async close() {} }),
    createDependenciesImpl: () => ({ async start() {}, async close() {} }),
    createActionJournalImpl: () => ({ async start() {}, async close() {} }),
    createIntentProposerImpl: () => ({ async close() {} }),
  });
  brain.emit("brainSwitched", { from: "codex", to: "claude", reason: "unreachable" });
  assert.deepEqual(rows, [{ type: "brainSwitched", from: "codex", to: "claude", reason: "unreachable" }]);
});
