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
    resolveProject: async name => name === "jester-voice" ?
      { kind: "local_available", locally_verified: true, path: "/projects/jester-voice", name } :
      { kind: "no_match" },
    spawnSession: async payload => { calls.push(["spawn", payload]); return {
      thread_id: "1554146845415055445", voice_label: "jinbe", status: "spawned",
    }; },
    setRuntime: async (...args) => { calls.push(["runtime", ...args]); return { status: "set" }; },
    closeSession: async (...args) => { calls.push(["close", ...args]); return { state: "pending" }; },
    searchSessions: async query => query === "login" ? [{ threadId: zoro.threadId,
      name: "Login audit", link: `https://discord.com/channels/1546639912848199742/${zoro.threadId}` }] : [],
  };
  const router = new OwnerRouter({ client, ownerId, now: () => now });
  return { router, client, calls, setRows: next => { rows = next; }, setNow: next => { now = next; } };
}

test("reads current session facts and ignores another speaker", async () => {
  const { router, calls } = setup();
  assert.equal(await router.handle("Jester, what is Frankie doing?", { speakerId: ownerId }),
    "franky is running. Task: Checking login");
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

test("creates a Codex session only in a verified project with its first task", async () => {
  const { router, calls } = setup();
  assert.match(await router.handle("Jester, start a new session in jester-voice to check the tests",
    { speakerId: ownerId }), /jinbe/);
  assert.deepEqual(calls[0], ["spawn", { projectPath: "/projects/jester-voice",
    instruction: "check the tests", ownerId, backend: "codex", model: null }]);
  assert.match(await router.handle("Create a session in mystery to check tests",
    { speakerId: ownerId }), /couldn't find/);
  assert.equal(calls.length, 1);
  await router.handle("Start a session in jester-voice with Claude Sonnet to check tests",
    { speakerId: ownerId });
  assert.deepEqual(calls[1][1], { projectPath: "/projects/jester-voice",
    instruction: "check tests", ownerId, backend: "claude", model: "sonnet" });
});

test("runtime change and close apply only to the named session", async () => {
  const { router, calls } = setup();
  assert.match(await router.handle("Switch Zoro to Claude Sonnet", { speakerId: ownerId }), /sonnet/);
  assert.deepEqual(calls[0], ["runtime", zoro.threadId, { backend: "claude", model: "sonnet" }]);
  assert.match(await router.handle("Close Zoro", { speakerId: ownerId }), /close after/);
  assert.deepEqual(calls[1], ["close", zoro.threadId, ownerId]);
});

test("history lookup uses EBI search and posts one exact thread link", async () => {
  const { router } = setup();
  const links = [];
  router.postLink = async (...args) => links.push(args);
  assert.match(await router.handle("Jester, find the session where we worked on login",
    { speakerId: ownerId }), /Auto Transcripts/);
  assert.deepEqual(links, [["Login audit",
    `https://discord.com/channels/1546639912848199742/${zoro.threadId}`]]);
});

test("follow-on speech stores exact running source and destination IDs", async () => {
  const { router, setRows } = setup();
  const scheduled = [];
  router.dependencies = { add: async item => scheduled.push(item) };
  const sanji = { threadId: "1554149594718281869", tag: "sanji", name: "Sanji",
    state: "history", closed: false };
  setRows([{ ...zoro, state: "running" }, sanji]);
  assert.match(await router.handle("When Zoro finishes, tell Sanji to run tests",
    { speakerId: ownerId }), /When zoro finishes/);
  assert.deepEqual(scheduled, [{ sourceId: zoro.threadId,
    destinationId: sanji.threadId, task: "run tests" }]);
});

test("combined-result request gets an honest limitation, not a false promise", async () => {
  const { router, calls } = setup();
  assert.match(await router.handle("When both Zoro and Sanji finish, tell me what I can test",
    { speakerId: ownerId }), /can't combine two session results yet/);
  assert.equal(calls.length, 0);
});

test("a just-listen or correction arriving during resolution cancels the pending action", async () => {
  const { router, client, calls } = setup();
  let allowed = true;
  const original = client.resolveTag;
  client.resolveTag = async name => { const result = await original(name); allowed = false; return result; };
  assert.equal(await router.handle("Tell Frankie to deploy", {
    speakerId: ownerId, shouldAct: () => allowed,
  }), null);
  assert.equal(calls.length, 0);
});

test("a tag reassigned during lookup cannot send to its old destination", async () => {
  const { router, client, calls } = setup();
  let lookups = 0;
  client.resolveTag = async () => ({ kind: "found", session: ++lookups === 1 ? franky : zoro });
  assert.match(await router.handle("Tell Frankie to check login", { speakerId: ownerId }), /tag changed/);
  assert.equal(calls.length, 0);
});
