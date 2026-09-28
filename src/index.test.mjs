import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startApp } from "./index.mjs";

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
    createConversationImpl: () => conversation,
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
  });
  await assert.rejects(app.start(), /fake offline login/);
  assert.deepEqual(calls, ["presence", "brain", "worker", "voice"]);
});
