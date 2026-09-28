import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { WorkerClient } from "./worker-client.mjs";

function fakeChild({ blocked = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.lines = [];
  let release = null;
  child.release = () => { release?.(); release = null; };
  child.stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      child.lines.push(String(chunk));
      if (blocked && !release) release = done;
      else done();
    },
  });
  child.finish = () => { child.release(); child.stdout.end(); };
  return child;
}

test("worker process restarts after a crash and never replays queued input", async () => {
  const children = [];
  const worker = new WorkerClient({
    command: "fake", restartBaseMs: 1, restartMaxMs: 2,
    spawnProcess() { const child = fakeChild(); children.push(child); return child; },
  });
  try {
    worker.send({ op: "audio", speaker: "owner", pcm: "first" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children[0].lines.length, 1);
    children[0].emit("exit", 1, null);
    worker.send({ op: "audio", speaker: "owner", pcm: "next" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(children.length, 2);
    assert.equal(children[1].lines.length, 1);
    assert.match(children[1].lines[0], /next/);
    assert.doesNotMatch(children[1].lines[0], /first/);
  } finally {
    await worker.close();
  }
});

test("idle suspend releases speech worker and next audio starts fresh without a failure", async () => {
  const children = [];
  const worker = new WorkerClient({ command: "fake", spawnProcess() {
    const child = fakeChild(); children.push(child); return child;
  } });
  let failures = 0;
  worker.on("fatal", () => failures++);
  try {
    worker.send({ op: "audio", speaker: "owner", pcm: "first" });
    await new Promise(resolve => setImmediate(resolve));
    worker.suspend();
    assert.equal(children[0].killed, true);
    children[0].emit("exit", 0, null);
    worker.send({ op: "audio", speaker: "owner", pcm: "second" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.match(children[1].lines[0], /second/);
    assert.equal(failures, 0);
  } finally { await worker.close(); }
});

test("worker bounds buffered audio and reset drops stale frames", async () => {
  const child = fakeChild({ blocked: true });
  const worker = new WorkerClient({ command: "fake", maxQueuedBytes: 180, spawnProcess: () => child });
  try {
    worker.send({ op: "audio", speaker: "owner", pcm: "x" });
    await new Promise((resolve) => setImmediate(resolve));
    worker.send({ op: "audio", speaker: "owner", pcm: "y" });
    worker.send({ op: "audio", speaker: "owner", pcm: "z" });
    assert.ok(worker.queuedBytes <= 180);
    worker.send({ op: "reset", speaker: "owner" });
    assert.equal(worker.queue.some((entry) => entry.op === "audio"), false);
    child.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.queuedBytes, 0);
  } finally {
    await worker.close();
  }
});

test("worker reply timeout kills a hung process and the next request gets a fresh one", async () => {
  const children = [];
  const worker = new WorkerClient({
    command: "fake", sayTimeoutMs: 20, restartBaseMs: 1, restartMaxMs: 2,
    spawnProcess() { const child = fakeChild(); children.push(child); return child; },
  });
  const failed = once(worker, "fatal");
  worker.send({ op: "say", id: "reply-hung", text: "No answer" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await failed;
  assert.equal(children[0].killed, true);
  worker.send({ op: "reset", speaker: "owner" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(children.length, 2);
  await worker.close();
});
