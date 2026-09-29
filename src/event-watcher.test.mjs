import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventWatcher } from "./event-watcher.mjs";
import { Dependencies } from "./dependencies.mjs";

const threadId = "1554145503506333736";
const tickWait = () => new Promise(resolve => setTimeout(resolve, 20));
const empty = () => ({ turns: [], next: null, has_more: false });

test("completed turns stay quiet by default, including an old queued notice after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  const file = join(dir, "events.json");
  let now = 0;
  const responses = [empty()];
  const spoken = [];
  const client = { turnUpdates: async () => responses.shift() || empty(),
    snapshot: async () => [{ threadId, tag: "franky" }] };
  const conversation = { mode: "conversation", turn: null, reply: null,
    announce: text => { spoken.push(text); return true; } };
  const presence = { inPresence: false, joined: false, paused: false };
  const watcher = new EventWatcher({ client, conversation, presence, file, now: () => now,
    intervalMs: 60_000 });
  try {
    await watcher.start();
    await tickWait();
    responses.push({ turns: [{ turn_key: "turn-1", thread_id: threadId, state: "accepted",
      updated_at: "2026-09-28T12:00:01+00:00" }],
    next: { since: "2026-09-28T12:00:01+00:00", after: "turn-1" }, has_more: false });
    await watcher.tick();
    assert.equal(spoken.length, 0);
    assert.equal(JSON.parse(await readFile(file, "utf8")).notices.length, 0);
    await watcher.close();
    const oldState = JSON.parse(await readFile(file, "utf8"));
    oldState.notices = [{ id: "old:accepted", threadId, kind: "finished", at: 0 }];
    await writeFile(file, JSON.stringify(oldState));

    const resumed = new EventWatcher({ client, conversation, presence, file, now: () => now,
      intervalMs: 60_000 });
    presence.inPresence = true;
    presence.joined = true;
    now = 3_000;
    await resumed.start();
    await tickWait();
    assert.deepEqual(spoken, []);
    await resumed.close();
    assert.equal(JSON.parse(await readFile(file, "utf8")).notices.length, 0);
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replacement turn suppresses a parked failure during the grace period", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  let now = 0;
  const responses = [empty()];
  const client = { turnUpdates: async () => responses.shift() || empty(), snapshot: async () => [] };
  const spoken = [];
  const watcher = new EventWatcher({ client,
    conversation: { mode: "conversation", turn: null, reply: null,
      announce: text => { spoken.push(text); return true; } },
    presence: { inPresence: true, joined: true, paused: false },
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000 });
  try {
    await watcher.start();
    await tickWait();
    responses.push({ turns: [
      { turn_key: "turn-old", thread_id: threadId, state: "scheduled", parked: true,
        updated_at: "2026-09-28T12:00:01+00:00" },
      { turn_key: "turn-new", thread_id: threadId, state: "running", parked: false,
        updated_at: "2026-09-28T12:00:02+00:00" },
    ], next: { since: "2026-09-28T12:00:02+00:00", after: "turn-new" }, has_more: false });
    await watcher.tick();
    now = 6_000;
    await watcher.tick();
    assert.equal(spoken.length, 0);
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired turn reports a possible failure and blocks follow-on work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  let now = 0;
  const responses = [empty()];
  const spoken = [];
  const failed = [];
  const watcher = new EventWatcher({
    client: { turnUpdates: async () => responses.shift() || empty(),
      snapshot: async () => [{ threadId, tag: "franky" }] },
    conversation: { mode: "conversation", turn: null, reply: null,
      announce: text => { spoken.push(text); return true; } },
    presence: { inPresence: true, joined: true, paused: false },
    dependencies: { async failed(id, turn) { failed.push([id, turn.updated_at, turn.terminal]); }, async reconcile() {} },
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000,
  });
  try {
    await watcher.start();
    await tickWait();
    responses.push({ turns: [{ turn_key: "expired-1", thread_id: threadId,
      state: "scheduled", parked: true, updated_at: "2026-09-28T12:00:01+00:00" }],
    next: { since: "2026-09-28T12:00:01+00:00", after: "expired-1" }, has_more: false });
    await watcher.tick();
    assert.equal(spoken.length, 0);
    responses.push({ turns: [{ turn_key: "expired-1", thread_id: threadId,
      state: "expired", parked: false, updated_at: "2026-09-28T12:00:02+00:00" }],
    next: { since: "2026-09-28T12:00:02+00:00", after: "expired-1" }, has_more: false });
    await watcher.tick();
    now = 6_000;
    await watcher.tick();
    assert.deepEqual(failed, [[threadId, "2026-09-28T12:00:02+00:00", true]]);
    assert.deepEqual(spoken, []);
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a three-session result watch posts per-session evidence and speaks once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  const ids = [threadId, "1553779983158349925", "1554149594718281869"];
  let now = Date.parse("2026-09-28T12:00:00Z");
  const responses = [empty()];
  const posts = [];
  const spoken = [];
  const client = { turnUpdates: async () => responses.shift() || empty(),
    threadMessages: async id => [{ is_bot: true, content: `Done.\n- Open ${id} locally`,
      created_at: "2026-09-28T12:00:03Z",
      jump_url: `https://discord.com/channels/1/${id}/2` }] };
  const deps = new Dependencies({ client, ownerId: "488763953397235712",
    file: join(dir, "dependencies.json"), now: () => now });
  const watcher = new EventWatcher({ client, dependencies: deps,
    conversation: { mode: "conversation", turn: null, reply: null,
      announce: text => { spoken.push(text); return true; } },
    presence: { inPresence: true, joined: true, paused: false },
    postResults: async (...args) => posts.push(args),
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000 });
  try {
    await deps.start();
    await deps.addResultWatch({ sources: ids.map((id, i) => ({ threadId: id,
      label: ["franky", "zoro", "sanji"][i] })) });
    await watcher.start();
    await tickWait();
    responses.push({ turns: ids.map((id, i) => ({ turn_key: `turn-${i}`,
      thread_id: id, state: "accepted", accepted_at: "2026-09-28T12:00:02Z",
      updated_at: "2026-09-28T12:00:02Z" })),
    next: { since: "2026-09-28T12:00:02Z", after: "turn-2" }, has_more: false });
    await watcher.tick();
    assert.equal(posts.length, 0);
    now += 3_000;
    await watcher.tick();
    assert.equal(posts.length, 1);
    assert.match(posts[0][0], /## sanji/);
    assert.match(posts[0][0], /Open 1554149594718281869 locally/);
    assert.equal(spoken.length, 1);
    await watcher.tick();
    assert.equal(posts.length, 1);
    assert.equal(spoken.length, 1);
  } finally {
    await watcher.close();
    await deps.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unavailable result channel eventually tells Drew instead of waiting forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  let now = Date.parse("2026-09-28T12:00:00Z");
  const spoken = [];
  const client = { turnUpdates: async () => empty(), threadMessages: async () => [
    { is_bot: true, content: "- Try the local page", created_at: "2026-09-28T12:00:03Z" },
  ] };
  const deps = new Dependencies({ client, ownerId: "488763953397235712",
    file: join(dir, "dependencies.json"), now: () => now, logger: { warn() {} } });
  const watcher = new EventWatcher({ client, dependencies: deps,
    conversation: { mode: "conversation", turn: null, reply: null,
      announce: text => { spoken.push(text); return true; } },
    presence: { inPresence: true, joined: true, paused: false },
    postResults: async () => { throw new Error("Discord offline"); },
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000,
    logger: { warn() {} } });
  try {
    await deps.start();
    await deps.addResultWatch({ sources: [{ threadId, label: "franky" }] });
    await deps.accepted(threadId, { accepted_at: "2026-09-28T12:00:02Z" });
    await watcher.start();
    await tickWait();
    now += 31_000;
    await watcher.tick();
    assert.match(spoken[0], /couldn't post their test details/);
    assert.equal(deps.readyResultWatches().length, 0);
  } finally {
    await watcher.close();
    await deps.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a posted result is not posted again when saving that fact fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  let now = Date.parse("2026-09-28T12:00:00Z");
  const posts = [];
  const client = { turnUpdates: async () => empty(), threadMessages: async () => [
    { is_bot: true, content: "- Try the local page", created_at: "2026-09-28T12:00:03Z" },
  ] };
  const deps = new Dependencies({ client, ownerId: "488763953397235712",
    file: join(dir, "dependencies.json"), now: () => now, logger: { warn() {} } });
  const watcher = new EventWatcher({ client, dependencies: deps,
    conversation: { mode: "conversation", turn: null, reply: null, announce: () => true },
    presence: { inPresence: true, joined: true, paused: false },
    postResults: async (...args) => posts.push(args),
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000,
    logger: { warn() {} } });
  try {
    await deps.start();
    await deps.addResultWatch({ sources: [{ threadId, label: "franky" }] });
    await deps.accepted(threadId, { accepted_at: "2026-09-28T12:00:02Z" });
    await watcher.start();
    await tickWait();
    deps.markReportPosted = async () => { throw new Error("disk full"); };
    for (const step of [3_000, 5_000, 30_000, 5_000]) {
      now += step;
      await watcher.tick().catch(() => {});
    }
    assert.equal(posts.length, 1, "Discord already has the attachment; do not repeat it");
  } finally {
    await watcher.close();
    await deps.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("while the owner is away, finished work is neither spoken nor posted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-events-"));
  let now = Date.parse("2026-09-28T12:00:00Z");
  const posts = [];
  let announced = 0;
  const client = { turnUpdates: async () => empty(), threadMessages: async () => [
    { is_bot: true, content: "- Try the local page", created_at: "2026-09-28T12:00:03Z" },
  ] };
  const deps = new Dependencies({ client, ownerId: "488763953397235712",
    file: join(dir, "dependencies.json"), now: () => now, logger: { warn() {} } });
  const presence = { inPresence: false, joined: false, paused: false };
  const watcher = new EventWatcher({ client, dependencies: deps,
    conversation: { mode: "conversation", turn: null, reply: null,
      announce: () => { announced += 1; return true; } },
    presence, postResults: async (...args) => posts.push(args),
    file: join(dir, "events.json"), now: () => now, intervalMs: 60_000, logger: { warn() {} } });
  try {
    await deps.start();
    await deps.addResultWatch({ sources: [{ threadId, label: "franky" }] });
    await deps.accepted(threadId, { accepted_at: "2026-09-28T12:00:02Z" });
    await watcher.start();
    await tickWait(); // let the start-up poll finish so each tick below really runs
    for (let i = 0; i < 5; i += 1) {
      now += 60_000;
      assert.equal(watcher.polling, false);
      await watcher.tick();
    }
    assert.deepEqual([announced, posts.length], [0, 0]);
    assert.equal(deps.readyResultWatches().length, 1, "kept for when the owner returns");
    Object.assign(presence, { inPresence: true, joined: true });
    await watcher.tick();
    assert.deepEqual([announced, posts.length], [1, 1]);
  } finally {
    await watcher.close();
    await deps.close();
    await rm(dir, { recursive: true, force: true });
  }
});
