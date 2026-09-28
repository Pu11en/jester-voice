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

test("group handoff waits for every source, dispatches once, and blocks on a failed source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  const file = join(dir, "dependencies.json");
  const secondId = "1554149594718281869";
  const calls = [];
  const client = { snapshot: async () => [{ threadId: destinationId, closed: false }],
    sendSpoken: async payload => { calls.push(payload); return { status: "posted" }; } };
  try {
    const deps = new Dependencies({ client, ownerId, file });
    await deps.start();
    const sources = [{ threadId: sourceId, label: "zoro" }, { threadId: secondId, label: "sanji" }];
    await deps.addGroup({ sources, destinationId, task: "check links" });
    await deps.accepted(sourceId);
    assert.equal(calls.length, 0);
    await deps.accepted(secondId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, destinationId);
    await deps.close();
    const resumed = new Dependencies({ client, ownerId, file });
    await resumed.start();
    await resumed.accepted(sourceId);
    await resumed.accepted(secondId);
    assert.equal(calls.length, 1);
    await resumed.addGroup({ sources, destinationId, task: "do not run" });
    await resumed.failed(sourceId, { terminal: true });
    await resumed.accepted(secondId);
    assert.equal(calls.length, 1);
    await resumed.close();
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

test("a named result group tracks every exact ID across restart and ignores older turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  const file = join(dir, "dependencies.json");
  const thirdId = "1554149594718281869";
  let now = Date.parse("2026-09-28T12:00:00Z");
  const client = { snapshot: async () => [] };
  try {
    const deps = new Dependencies({ client, ownerId, file, now: () => now });
    await deps.start();
    const sources = [
      { threadId: sourceId, label: "zoro" },
      { threadId: destinationId, label: "franky" },
      { threadId: thirdId, label: "sanji" },
    ];
    const watch = await deps.addResultWatch({ sources });
    assert.equal((await deps.addResultWatch({ sources: [...sources].reverse() })).id, watch.id);
    await deps.accepted(sourceId, { accepted_at: "2026-09-28T11:59:59Z" });
    assert.equal(deps.readyResultWatches().length, 0);
    await deps.accepted(sourceId, { accepted_at: "2026-09-28T12:00:02Z" });
    await deps.accepted(destinationId, { accepted_at: "2026-09-28T12:00:03Z" });
    await deps.close();

    const resumed = new Dependencies({ client, ownerId, file, now: () => now });
    await resumed.start();
    await resumed.failed(thirdId, { updated_at: "2026-09-28T12:00:04Z", terminal: false });
    assert.equal(resumed.readyResultWatches().length, 0);
    await resumed.accepted(thirdId, { accepted_at: "2026-09-28T12:00:05Z" });
    const [ready] = resumed.readyResultWatches();
    assert.deepEqual(Object.keys(ready.completed), [sourceId, destinationId, thirdId]);
    assert.equal(ready.completed[thirdId].status, "accepted");
    await resumed.markReportPosted(ready.id);
    await resumed.markResultsDelivered(ready.id);
    assert.equal(resumed.readyResultWatches().length, 0);
    await resumed.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a confirmed expiry is reported as failed only for its exact watched session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-deps-"));
  const now = Date.parse("2026-09-28T12:00:00Z");
  try {
    const deps = new Dependencies({ client: {}, ownerId,
      file: join(dir, "dependencies.json"), now: () => now });
    await deps.start();
    await deps.addResultWatch({ sources: [
      { threadId: sourceId, label: "zoro" },
      { threadId: destinationId, label: "franky" },
    ] });
    await deps.failed(sourceId, { updated_at: "2026-09-28T12:00:02Z", terminal: true });
    await deps.accepted(destinationId, { accepted_at: "2026-09-28T12:00:03Z" });
    const [ready] = deps.readyResultWatches();
    assert.equal(ready.completed[sourceId].status, "failed");
    assert.equal(ready.completed[destinationId].status, "accepted");
    await deps.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
