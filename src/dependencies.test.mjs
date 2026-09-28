import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Dependencies } from "./dependencies.mjs";

const sourceId = "1553779983158349925";
const destinationId = "1554145503506333736";
const ownerId = "488763953397235712";

test("one accepted source turn sends one exact follow-on task, even after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  const file = join(dir, "dependencies.json");
  const calls = [];
  const client = { snapshot: async () => [{ threadId: destinationId, closed: false }],
    sendSpoken: async payload => { calls.push(payload); return { status: "posted" }; } };
  try {
    const deps = new Dependencies({ client, ownerId, file });
    await deps.start();
    await deps.add({ sourceId, destinationId, task: "run the checks" });
    await deps.accepted(sourceId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, destinationId);
    assert.equal(calls[0].speakerId, ownerId);
    assert.equal(calls[0].text, "run the checks");
    await deps.close();
    const resumed = new Dependencies({ client, ownerId, file });
    await resumed.start();
    await resumed.accepted(sourceId);
    assert.equal(calls.length, 1);
    await resumed.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uncertain delivery retries the same request ID; failed source blocks dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  let now = 0;
  const calls = [];
  const client = { snapshot: async () => [{ threadId: destinationId, closed: false }],
    sendSpoken: async payload => {
      calls.push(payload);
      if (calls.length === 1) throw new Error("lost response");
      return { status: "posted" };
    } };
  try {
    const deps = new Dependencies({ client, ownerId, file: join(dir, "dependencies.json"),
      now: () => now, logger: { warn() {} } });
    await deps.start();
    await deps.add({ sourceId, destinationId, task: "test login" });
    await deps.accepted(sourceId);
    assert.equal(calls.length, 1);
    now = 11_000;
    await deps.reconcile();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].requestId, calls[1].requestId);
    await deps.add({ sourceId, destinationId, task: "do not run" });
    await deps.failed(sourceId);
    await deps.accepted(sourceId);
    assert.equal(calls.length, 2);
    await deps.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("just-listen cancellation prevents a queued follow-on task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  const calls = [];
  const client = { snapshot: async () => [{ threadId: destinationId, closed: false }],
    sendSpoken: async payload => { calls.push(payload); return { status: "posted" }; } };
  try {
    const deps = new Dependencies({ client, ownerId, file: join(dir, "dependencies.json") });
    await deps.start();
    await deps.add({ sourceId, destinationId, task: "run the checks" });
    await deps.cancelPending();
    await deps.accepted(sourceId);
    assert.equal(calls.length, 0);
    await deps.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
