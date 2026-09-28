import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventWatcher } from "./event-watcher.mjs";

const threadId = "1554145503506333736";
const tickWait = () => new Promise(resolve => setTimeout(resolve, 20));
const empty = () => ({ turns: [], next: null, has_more: false });

test("completed turns wait for owner and quiet gap, survive restart, then speak once", async () => {
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
    assert.equal(JSON.parse(await readFile(file, "utf8")).notices.length, 1);
    await watcher.close();

    const resumed = new EventWatcher({ client, conversation, presence, file, now: () => now,
      intervalMs: 60_000 });
    presence.inPresence = true;
    presence.joined = true;
    now = 3_000;
    await resumed.start();
    await tickWait();
    assert.deepEqual(spoken, ["franky finished a turn."]);
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
    dependencies: { async failed(id) { failed.push(id); }, async reconcile() {} },
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
    assert.deepEqual(failed, [threadId]);
    assert.deepEqual(spoken, ["franky stopped or may need attention."]);
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});
