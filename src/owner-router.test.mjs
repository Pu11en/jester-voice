import assert from "node:assert/strict";
import test from "node:test";
import { OwnerRouter } from "./owner-router.mjs";

const ownerId = "488763953397235712";
const franky = { threadId: "1553899450227757156", tag: "franky", name: "Franky", state: "running", currentTask: "Checking login", closed: false };
const zoro = { threadId: "1553779983158349925", tag: "zoro", name: "Zoro", state: "history", currentTask: "", closed: false };

function setup() {
  const calls = [];
  let now = 0;
  let rows = [franky, zoro];
  const client = {
    snapshot: async () => rows,
    resolveTag: async name => {
      const matches = rows.filter(s => !s.closed && (s.tag === name.toLowerCase() ||
        (name.toLowerCase() === "frankie" && s.tag === "franky")));
      return matches.length === 1 ? { kind: "found", session: matches[0] } :
        matches.length ? { kind: "ambiguous", matches } : { kind: "unknown" };
    },
    sendSpoken: async payload => { calls.push(payload); return { request_id: "jester-test", status: "posted" }; },
    spokenReceipt: async () => ({ request_id: "jester-test", status: "posted" }),
    stopTurn: async (...args) => { calls.push(["stop", ...args]); return { status: "stopped" }; },
  };
  const router = new OwnerRouter({ client, ownerId, now: () => now });
  return { router, calls, setRows: next => { rows = next; }, setNow: next => { now = next; } };
}

test("reads current session facts and ignores another speaker", async () => {
  const { router, calls } = setup();
  assert.equal(await router.handle("Jester, what is Frankie doing?", { speakerId: ownerId }),
    "franky is running. Checking login");
  assert.equal(await router.handle("Who's running?", { speakerId: ownerId }), "Running: franky.");
  assert.equal(await router.handle("Tell Frankie to deploy", { speakerId: "someone else" }), null);
  assert.equal(calls.length, 0);
});

test("posts one faithful task to the exact resolved thread and binds follow-up", async () => {
  const { router, calls, setNow } = setup();
  assert.equal(await router.handle("And Frankie, we need to fix the navigation", { speakerId: ownerId }),
    "I posted your task to franky.");
  assert.deepEqual(calls[0], { threadId: franky.threadId, speakerId: ownerId,
    text: "we need to fix the navigation" });
  assert.equal(await router.handle("Tell him to add a test", { speakerId: ownerId, allowReference: true }),
    "I posted your task to franky.");
  assert.equal(calls[1].threadId, franky.threadId);
  setNow(61_000);
  assert.match(await router.handle("Tell him to retry", { speakerId: ownerId, allowReference: true }), /can't find/);
  assert.equal(calls.length, 2);
});

test("final corrected task wins while changed and ambiguous targets do not dispatch", async () => {
  const { router, calls, setRows } = setup();
  assert.match(await router.handle("Tell Frankie to deploy—actually just test", { speakerId: ownerId }), /posted/);
  assert.equal(calls[0].text, "just test");
  setRows([{ ...franky, closed: true }, zoro]);
  assert.match(await router.handle("Tell Frankie to check", { speakerId: ownerId }), /can't find/);
  setRows([franky, { ...zoro, tag: "franky" }]);
  assert.match(await router.handle("Tell Frankie to check", { speakerId: ownerId }), /More than one/);
  assert.equal(calls.length, 1);
});

test("stop sends no prompt and targets only the resolved active turn", async () => {
  const { router, calls } = setup();
  assert.equal(await router.handle("Jester, stop Zoro", { speakerId: ownerId }),
    "I stopped zoro's current turn.");
  assert.deepEqual(calls, [["stop", zoro.threadId, ownerId]]);
});
