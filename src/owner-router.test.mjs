import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerRouter } from "./owner-router.mjs";
import { ActionJournal } from "./action-journal.mjs";

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
  assert.equal(await router.handle("Who's running?", { speakerId: ownerId }),
    "Sessions: franky (running): Checking login.");
  assert.equal(await router.handle("Tell Frankie to deploy", { speakerId: "someone else" }), null);
  assert.equal(calls.length, 0);
});

test("binds a read-only evidence pack to the exact thread for follow-up questions", async () => {
  const { client, calls } = setup();
  const reader = { read: async session => `Substantive result in ${session.threadId}` };
  const router = new OwnerRouter({ client, ownerId, sessionReader: reader });
  const first = await router.readContext({ kind: "status-one", target: "Zoro" });
  assert.equal(first.kind, "context");
  assert.match(first.text, new RegExp(zoro.threadId));
  const followUp = await router.readContext({ kind: "status-last", target: "it" },
    { allowReference: true });
  assert.equal(followUp.threadId, zoro.threadId);
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

test("a lost spoken response is reconciled after restart without a second send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-route-actions-"));
  try {
    const { client, calls } = setup();
    let receiptKnown = false;
    client.sendSpoken = async payload => { calls.push(payload); throw new Error("lost response"); };
    client.spokenReceipt = async () => {
      if (!receiptKnown) throw new Error("receipt unavailable");
      return { status: "posted" };
    };
    const file = join(dir, "actions.json");
    const firstJournal = new ActionJournal({ file });
    await firstJournal.start();
    const first = new OwnerRouter({ client, ownerId, actionJournal: firstJournal });
    assert.match(await first.handle("Tell Frankie to check login", { speakerId: ownerId }), /couldn't verify/);
    assert.equal(calls.length, 1);
    await firstJournal.close();
    receiptKnown = true;
    const secondJournal = new ActionJournal({ file });
    await secondJournal.start();
    const second = new OwnerRouter({ client, ownerId, actionJournal: secondJournal });
    assert.match(await second.handle("Tell Frankie to check login", { speakerId: ownerId }), /posted/);
    assert.equal(calls.length, 1);
    await secondJournal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repeated speech sends no task while the action identity cannot be saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-route-save-failure-"));
  const journal = new ActionJournal({ file: join(dir, "actions.json") });
  try {
    await journal.start();
    await writeFile(join(dir, "blocked"), "not a directory");
    journal.file = join(dir, "blocked", "actions.json");
    const { client, calls } = setup();
    client.spokenReceipt = async () => {
      const error = new Error("no receipt");
      error.status = 404;
      throw error;
    };
    const router = new OwnerRouter({ client, ownerId, actionJournal: journal });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await router.handle("Tell Frankie to check login", { speakerId: ownerId }).catch(() => {});
    }
    assert.equal(calls.length, 0, "no EBI POST may precede a durable action identity");
  } finally {
    await journal.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing EBI receipt retries only under its saved request ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-route-actions-"));
  try {
    const { client, calls } = setup();
    client.sendSpoken = async payload => {
      calls.push(payload);
      if (calls.length === 1) throw new Error("connection lost before reserve");
      return { status: "posted", request_id: payload.requestId };
    };
    client.spokenReceipt = async () => { const error = new Error("not found"); error.status = 404; throw error; };
    const file = join(dir, "actions.json");
    const journal = new ActionJournal({ file });
    await journal.start();
    const router = new OwnerRouter({ client, ownerId, actionJournal: journal });
    assert.match(await router.handle("Tell Frankie to check login", { speakerId: ownerId }), /couldn't verify/);
    assert.match(await router.handle("Tell Frankie to check login", { speakerId: ownerId }), /posted/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].requestId, calls[1].requestId);
    await journal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("an explicit empty session creates no invented first task", async () => {
  const { router, calls, client } = setup();
  client.resolveProject = async () => ({ kind: "local_available", locally_verified: true,
    path: "/projects/jobs", name: "Jobs" });
  assert.match(await router.handle("Jester, open an empty thread in Jobs",
    { speakerId: ownerId }), /No task is queued/);
  assert.deepEqual(calls[0], ["spawn", { projectPath: "/projects/jobs", instruction: null,
    empty: true, threadName: "Jobs", ownerId, backend: "codex", model: null }]);
});

test("a lost session creation response is reconciled without a second spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-spawn-actions-"));
  try {
    const { client, calls } = setup();
    let found = false;
    client.spawnSession = async payload => { calls.push(["spawn", payload]); throw new Error("lost response"); };
    client.spawnCorrelation = async () => {
      if (!found) throw new Error("not yet visible");
      return { thread_id: "1554146845415055445", voice_label: "jinbe", status: "existing" };
    };
    const file = join(dir, "actions.json");
    const firstJournal = new ActionJournal({ file });
    await firstJournal.start();
    const first = new OwnerRouter({ client, ownerId, actionJournal: firstJournal });
    assert.match(await first.handle("Create a session in jester-voice to check tests",
      { speakerId: ownerId }), /couldn't verify/);
    await firstJournal.close();
    found = true;
    const secondJournal = new ActionJournal({ file });
    await secondJournal.start();
    const second = new OwnerRouter({ client, ownerId, actionJournal: secondJournal });
    assert.match(await second.handle("Create a session in jester-voice to check tests",
      { speakerId: ownerId }), /jinbe/);
    assert.equal(calls.length, 1);
    await secondJournal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("result watch resolves a named group to distinct exact running IDs", async () => {
  const { router, setRows, calls } = setup();
  const watched = [];
  router.dependencies = { addResultWatch: async item => watched.push(item) };
  const sanji = { threadId: "1554149594718281869", tag: "sanji", name: "Sanji",
    state: "running", closed: false };
  setRows([{ ...zoro, state: "running" }, sanji, franky]);
  assert.match(await router.handle("When Zoro, Sanji, and Frankie finish, tell me what I can test",
    { speakerId: ownerId }), /watch 3 sessions/);
  assert.deepEqual(watched[0].sources.map(s => s.threadId),
    [zoro.threadId, sanji.threadId, franky.threadId]);
  assert.equal(calls.length, 0);
  assert.match(await router.handle("When all currently running sessions finish, tell me what I can test",
    { speakerId: ownerId }), /watch 3 sessions/);
  assert.equal(watched[1].sources.length, 3);
});

test("a session finishing during result-watch setup cannot leave a stale watch", async () => {
  const { router, client, setRows } = setup();
  const watched = [];
  router.dependencies = { addResultWatch: async item => watched.push(item) };
  setRows([{ ...zoro, state: "running" }, franky]);
  const original = client.snapshot;
  let reads = 0;
  client.snapshot = async () => {
    const rows = await original();
    return ++reads >= 1 ? rows.map(s => s.threadId === zoro.threadId ?
      { ...s, state: "history" } : s) : rows;
  };
  assert.match(await router.handle("When Zoro and Frankie finish, tell me what I can test",
    { speakerId: ownerId }), /working sessions changed/);
  assert.equal(watched.length, 0);
});

test("one result request can track a dozen sessions without a two-session cap", async () => {
  const { router, setRows } = setup();
  const watched = [];
  router.dependencies = { addResultWatch: async item => watched.push(item) };
  const rows = Array.from({ length: 12 }, (_, i) => ({
    threadId: String(1554149594718281869n + BigInt(i)), tag: `tag${i + 1}`,
    name: `Session ${i + 1}`, state: "running", closed: false,
  }));
  setRows(rows);
  const names = rows.map(r => r.tag);
  const sentence = `When ${names.slice(0, -1).join(", ")}, and ${names.at(-1)} finish, tell me what I can test`;
  assert.match(await router.handle(sentence, { speakerId: ownerId }), /watch 12 sessions/);
  assert.deepEqual(watched[0].sources.map(s => s.threadId), rows.map(r => r.threadId));
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

test("a repeated identical task says it was not sent again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-route-repeat-"));
  try {
    const { client, calls } = setup();
    const actionJournal = new ActionJournal({ file: join(dir, "actions.json") });
    await actionJournal.start();
    const router = new OwnerRouter({ client, ownerId, actionJournal });
    assert.match(await router.handle("Tell Frankie to check login", { speakerId: ownerId }),
      /^I posted your task/);
    const repeat = await router.handle("Tell Frankie to check login", { speakerId: ownerId });
    assert.equal(calls.length, 1);
    assert.match(repeat, /didn't send it again/, "a repeat must not sound like a new post");
    await actionJournal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a remote or unverified project never gets a local stand-in session", async () => {
  const { router, client, calls } = setup();
  for (const kind of ["remote_only", "unavailable", "ambiguous"]) {
    client.resolveProject = async name => ({ kind, locally_verified: false, path: `/elsewhere/${name}`, name });
    const reply = await router.handle("Start a session in jester-voice to check tests", { speakerId: ownerId });
    assert.match(reply, /couldn't find one available local project/);
  }
  assert.equal(calls.filter(call => call[0] === "spawn").length, 0);
});

test("an on-demand update names each running session with its state and task", async () => {
  const { router, setRows } = setup();
  setRows([franky, zoro, { ...zoro, threadId: "1554149594718281869", tag: "nami", state: "queued",
    currentTask: "" }]);
  const reply = await router.handle("Update me on my sessions", { speakerId: ownerId });
  assert.match(reply, /franky \(running\): Checking login/);
  assert.match(reply, /nami \(queued\): task unavailable/);
  assert.doesNotMatch(reply, /zoro/, "history sessions are not reported as work in progress");
});

const podlox = { threadId: "1554200000000000001", tag: "zoro", aliases: [], name: "podlox",
  project: "/home/drewp/main-projects/podlox", state: "recovering", currentTask: "", closed: false };
const taskLoop = { threadId: "1554200000000000002", tag: "", aliases: [], name: "Task loop",
  project: "/home/drewp/main-projects/task-loop", state: "history", currentTask: "", closed: false };
const oldAudit = { threadId: "1554200000000000003", tag: "", aliases: [], name: "Old audit",
  project: "/home/drewp/main-projects/old-audit", state: "history", currentTask: "", closed: true };
// Today's EBI rows always carry closed; a missing field must still count as open.
const nameless = Array.from({ length: 22 }, (_, i) => ({ threadId: String(1554200000000000100n + BigInt(i)),
  tag: "", aliases: [], name: "", project: "", state: "history", currentTask: "" }));

function snapshotOnly() {
  const state = setup();
  state.client.searchSessions = async () => { throw new Error("the thread search must not be needed"); };
  state.client.threadMessages = async () => { throw new Error("thread messages must not be needed"); };
  state.client.resolveTag = async () => { throw new Error("tag resolution must not be needed"); };
  return state;
}

test("lists every open session by name with its tag and state, without any brain", async () => {
  const { router, calls, setRows } = snapshotOnly();
  setRows([podlox, taskLoop, ...nameless, oldAudit]);
  const reply = await router.handle("What threads do we have open?", { speakerId: ownerId });
  assert.equal(reply, "24 open sessions: podlox (tag zoro, recovering); Task loop (no tag, idle); and 22 more without names.");
  assert.doesNotMatch(reply, /Old audit/, "closed rows are not open");
  assert.equal(calls.length, 0);
  setRows([oldAudit]);
  assert.equal(await router.handle("What's open?", { speakerId: ownerId }), "No sessions are open right now.");
  setRows([{ ...podlox, visible: false }, { ...taskLoop, visible: true }]);
  assert.match(await router.handle("Like what sessions that are actually open?", { speakerId: ownerId }),
    /^2 open sessions: podlox \(tag zoro, recovering\); Task loop \(no tag, idle\)\. 1 of them isn't visible in Discord\.$/);
});

test("session names are spoken without their title tag or emoji", async () => {
  const { router, setRows } = snapshotOnly();
  setRows([{ ...podlox, name: "[zoro] 📂 podlox" }]);
  assert.equal(await router.handle("What's open?", { speakerId: ownerId }),
    "1 open session: podlox (tag zoro, recovering).");
  assert.equal(await router.handle("Do you see podlox?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
});

test("see-one answers yes or no from open rows with a clear fuzzy match", async () => {
  const { router, calls, setRows } = snapshotOnly();
  setRows([podlox, taskLoop, oldAudit]);
  assert.equal(await router.handle("Jester, do you see pod locks?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
  assert.equal(await router.handle("Yo, Jester, do you see pod logs?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
  assert.equal(await router.handle("Is podlocks open?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
  assert.equal(await router.handle("Do you have Zoro?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
  assert.equal(await router.handle("Is the task loop thread open?", { speakerId: ownerId }),
    "Yes, Task loop is open. No tag, idle.");
  assert.equal(await router.handle("Do you see old audit?", { speakerId: ownerId }), "No, Old audit is closed.");
  assert.equal(await router.handle("Do you have Nami?", { speakerId: ownerId }),
    "No, I don't see an open session called Nami.");
  assert.equal(await router.handle("Tell it to check the tests", { speakerId: ownerId, allowReference: true }),
    "I posted your task to Task loop.", "the last yes answer binds its session for follow-ups");
  assert.equal(calls.at(-1).threadId, taskLoop.threadId);
});

test("why-no-tag counts the word holders and the untagged sessions from the snapshot", async () => {
  const { router, setRows } = snapshotOnly();
  setRows([podlox, taskLoop, ...nameless, oldAudit]);
  const reply = await router.handle(
    "Yeah, so I need you to, you know, how come there's nothing, like no tag on one of the sessions?",
    { speakerId: ownerId });
  assert.match(reply, /^1 of 10 voice words is held: zoro for podlox\. 9 words are free, so EBI did not run out of tags\./);
  assert.match(reply, /23 open sessions have no tag, including Task loop\./);
  const crew = ["luffy", "zoro", "nami", "sanji", "chopper", "franky", "jinbe", "usopp", "shanks", "mihawk"];
  setRows([...crew.map((tag, i) => ({ threadId: String(1554200000000000200n + BigInt(i)), tag, aliases: [],
    name: `Job ${i + 1}`, project: "", state: "running", currentTask: "", closed: false })), taskLoop]);
  const full = await router.handle("Why is there no tag on Task loop?", { speakerId: ownerId });
  assert.match(full, /^Task loop has no tag\. All 10 voice words are held: luffy for Job 1, zoro for Job 2, .* and 4 more\./);
  assert.match(full, /1 open session has no tag: Task loop\. Closing a session frees its word\.$/);
  assert.equal(await router.handle("Why does Job 3 have no tag?", { speakerId: ownerId }),
    "Job 3 does have a tag: nami.");
});

test("a bare find searches open rows by name or project before any thread search", async () => {
  const { router, client, calls, setRows } = snapshotOnly();
  setRows([podlox, taskLoop, oldAudit]);
  assert.equal(await router.handle("Find podlox", { speakerId: ownerId }), "I found podlox. Tag zoro, recovering.");
  assert.equal(await router.handle("Jester, search for pod locks", { speakerId: ownerId }),
    "I found podlox. Tag zoro, recovering.");
  assert.equal(await router.handle("Look up the task loop thread", { speakerId: ownerId }),
    "I found Task loop. No tag, idle.");
  assert.equal(calls.length, 0);
  const searched = [];
  client.searchSessions = async query => { searched.push(query); return [{ threadId: oldAudit.threadId,
    name: "Old audit", link: `https://discord.com/channels/1546639912848199742/${oldAudit.threadId}` }]; };
  assert.equal(await router.handle("Find old audit", { speakerId: ownerId }),
    "I couldn't find an open session about old audit.", "closed threads are deferred");
  assert.deepEqual(searched, ["old audit"]);
});

test("statusSentence speaks the deterministic status line without a brain", async () => {
  const { router } = setup();
  assert.equal(await router.statusSentence({ kind: "status-one", target: "Frankie" }),
    "franky is running. Task: Checking login");
  assert.equal(await router.statusSentence({ kind: "status-last", target: "it" }, { allowReference: true }),
    "franky is running. Task: Checking login", "the status line binds the session for follow-ups");
  assert.match(await router.statusSentence({ kind: "session-discuss", target: "Nami" }), /can't find an open session named Nami/);
});

test("a detected brain outage gets the honest Luna line while a misparse asks again", async () => {
  const { router } = setup();
  assert.equal(await router.handle("start something in podlox", { speakerId: ownerId,
    intent: { kind: "clarify", reason: "proposal-unavailable" } }),
  "Luna is out until October 4. I can still list, find, send, stop and close sessions.");
  assert.equal(await router.handle("start something in podlox", { speakerId: ownerId,
    intent: { kind: "clarify", reason: "proposal-invalid" } }),
  "Please say the final task once more so I send the right words.");
});

const foreign = [
  { threadId: "1554300000000000001", name: "📂 youtube-money", ownerId: "1550644558176460961",
    ownerName: "david", channel: "control-center" },
  { threadId: "1554300000000000002", name: "cranesignal", ownerId: "1550644558176460961",
    ownerName: "david", channel: "workers" },
  { threadId: "1554300000000000003", name: "📂 meme-explorer", ownerId: "1546757772052537385",
    ownerName: "I mac codex", channel: "control-center" },
  { threadId: "1554300000000000004", name: "📂 ebi-agent-chat-relay", ownerId: "1546757772052537385",
    ownerName: "I mac codex", channel: "control-center" },
];

test("list-open speaks EBI sessions first, then other bots' threads grouped by owner", async () => {
  const { router, client, calls, setRows } = snapshotOnly();
  setRows([podlox]);
  const before = await router.handle("What's open?", { speakerId: ownerId });
  assert.equal(before, "1 open session: podlox (tag zoro, recovering).");
  client.otherThreads = [];
  assert.equal(await router.handle("What's open?", { speakerId: ownerId }), before);
  client.otherThreads = foreign;
  assert.equal(await router.handle("What's open?", { speakerId: ownerId }),
    "1 open session: podlox (tag zoro, recovering). Also open in Discord, run by other bots: " +
    "youtube-money and cranesignal by david; meme-explorer and ebi-agent-chat-relay by I mac codex.");
  client.otherThreads = [...foreign, { threadId: "1554300000000000005", name: "[x] 🧪 lab", ownerId: "",
    ownerName: "", channel: "" }, ...["a1", "b2", "c3"].map((name, i) => ({ threadId: `155430000000000001${i}`,
    name, ownerId: "9", ownerName: "", channel: "" }))];
  assert.equal(await router.handle("What's open?", { speakerId: ownerId }),
    "1 open session: podlox (tag zoro, recovering). Also open in Discord, run by other bots: " +
    "youtube-money and cranesignal by david; meme-explorer and ebi-agent-chat-relay by I mac codex; " +
    "lab by someone else; a1 by someone else; and 2 more.");
  assert.equal(calls.length, 0);
});

test("see-one and find name the other bot that runs a foreign thread", async () => {
  const { router, client, setRows } = snapshotOnly();
  setRows([podlox, oldAudit]);
  client.otherThreads = foreign;
  assert.equal(await router.handle("Do you see youtube money?", { speakerId: ownerId }),
    "Yes, youtube-money is open in Discord, but david runs it, so I can't see its work or send it tasks.");
  assert.equal(await router.handle("Do you see podlox?", { speakerId: ownerId }),
    "Yes, podlox is open. Tag zoro, recovering.");
  assert.equal(await router.handle("Do you see old audit?", { speakerId: ownerId }), "No, Old audit is closed.");
  assert.equal(await router.handle("Find meme explorer", { speakerId: ownerId }),
    "I found meme-explorer in Discord, but I mac codex runs it, so I can't see its work or send it tasks.");
  client.otherThreads = [{ ...foreign[0], ownerId: "", ownerName: "" }];
  assert.equal(await router.handle("Is youtube money open?", { speakerId: ownerId }),
    "Yes, youtube-money is open in Discord, but someone else runs it, so I can't see its work or send it tasks.");
});
