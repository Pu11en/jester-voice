import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Conversation, heardWords, mergeText } from "./conversation.mjs";
import { createVoice } from "./voice.mjs";
import { BRAIN_OUT_LINE } from "./owner-router.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup({ answers = ["A reply."], brainAsk = null, presence = null, transcript = null, voice: suppliedVoice = null } = {}) {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.send = (message) => worker.sent.push(message);
  const brain = new EventEmitter();
  brain.asks = [];
  brain.context = [];
  brain.interrupts = 0;
  brain.ask = brainAsk || (async function* (text) {
    this.asks.push(text);
    const answer = answers.shift() || "Merged reply.";
    yield answer;
  });
  brain.interrupt = async () => { brain.interrupts += 1; };
  brain.injectContext = (text) => brain.context.push(text);
  const player = new EventEmitter();
  const voice = suppliedVoice || Object.assign(new EventEmitter(), {
    player,
    played: [],
    stopped: 0,
    muted: [],
    setSelfMuted(muted) { this.muted.push(muted); },
    play(id, stream) { this.played.push({ id, stream }); },
    stopNow() { this.stopped += 1; },
    playedMs() { return 600; },
    displayName(id) { return id === "guest" ? "Guest Name" : id; },
  });
  worker.dropQueuedAudio = (speaker, keep) => { worker.dropped = [speaker, keep]; };
  const events = (ev, payload = {}) => worker.emit("event", { ev, speaker: "owner", ...payload });
  return { worker, brain, voice, events, presence, transcript };
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await tick();
  }
}

function speechPcm(sample) {
  const pcm = Buffer.alloc(3_840 * 5); // Five 20 ms stereo PCM frames.
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(sample, offset);
  return pcm.toString("base64");
}

async function withConversation(options, fn) {
  const dir = await mkdtemp(join(tmpdir(), "jester-conversation-"));
  const parts = setup(options);
  const conversation = new Conversation({ ...parts, now: options.now, ownerId: "owner",
    ownerRouter: options.ownerRouter, intentProposer: options.intentProposer,
    logFile: join(dir, "turns.jsonl"), ...(options.logger ? { logger: options.logger } : {}) });
  conversation.start();
  // Existing playback/timing tests exercise an already engaged exchange.
  // Attention regressions below use dormant: true and wake through worker events.
  if (!options.dormant) conversation.attention.accept("Jester");
  try { await fn({ ...parts, conversation, logPath: join(dir, "turns.jsonl") }); }
  finally { await conversation.close(); await rm(dir, { recursive: true, force: true }); }
}

test("close drains queued route evidence before returning", async () => {
  await withConversation({}, async ({ conversation, logPath }) => {
    const gate = Promise.withResolvers();
    conversation.logQueue = gate.promise;
    conversation.traceRoute({ stage: "prepared", actionId: "offline-action" });
    let closed = false;
    const closing = conversation.close().then(() => { closed = true; });
    try {
      await tick();
      assert.equal(closed, false, "shutdown must wait for queued evidence");
      gate.resolve();
      await closing;
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.at(-1).actionId, "offline-action");
    } finally {
      gate.resolve();
      await closing;
      await conversation.logQueue;
    }
  });
});

test("speculative answer stays silent, is discarded on resumed speech, and merges into the next ask", async () => {
  await withConversation({ answers: ["Discard this.", "Use the merged thought."] }, async ({ events, brain, worker }) => {
    events("pause", { prob: 0.7, text: "Tell me about" });
    await tick();
    assert.equal(worker.sent.some((message) => message.op === "say"), false);
    events("speech_start");
    await tick();
    events("turn_end", { text: "Tell me about Luna please.", ms: { utterance: 900 } });
    await tick();
    assert.equal(brain.asks[0], "Tell me about");
    assert.equal(brain.asks[1], "Tell me about Luna please.");
    assert.deepEqual(worker.sent.filter((message) => message.op === "say").map((message) => message.text), ["Use the merged thought."]);
    assert.ok(brain.interrupts >= 1);
  });
});

test("named owner task routes after final speech; transcript-only and guests do not dispatch", async () => {
  const handled = [];
  const ownerRouter = { reset() {}, sessionTags: async () => ["frankie"],
    handle: async (...args) => { handled.push(args); return "I posted your task to Frankie."; } };
  await withConversation({ ownerRouter, answers: ["Wrong Luna answer."] }, async ({ events, worker, brain }) => {
    events("turn_end", { text: "And Frankie, fix the login", ms: { utterance: 900 } });
    await waitUntil(() => handled.length === 1, "owner task route");
    assert.equal(handled[0][0], "And Frankie, fix the login");
    assert.equal(brain.asks.length, 0);
    assert.deepEqual(worker.sent.filter(m => m.op === "say").map(m => m.text),
      ["I posted your task to Frankie."]);
    worker.emit("event", { ev: "turn_end", speaker: "guest", text: "Tell Frankie to deploy" });
    events("turn_end", { text: "Jester just listen" });
    events("turn_end", { text: "Jester, tell Frankie to deploy" });
    await tick();
    assert.equal(handled.length, 1);
  });
});

test("a natural model proposal is checked through the owner action router", async () => {
  const handled = [];
  const ownerRouter = { reset() {}, sessionTags: async () => ["zoro"],
    handle: async (_text, options) => { handled.push(options); return "I posted your task to Zoro."; } };
  const intentProposer = { likelyWork: () => true,
    propose: async () => ({ kind: "message", target: "zoro", instruction: "review the login page" }),
    interrupt: async () => {} };
  await withConversation({ ownerRouter, intentProposer, dormant: true }, async ({ events }) => {
    events("turn_end", { text: "Jester, could you put this in Zoro's thread: review the login page" });
    await waitUntil(() => handled.length === 1, "natural task route");
    assert.deepEqual(handled[0].intent, { kind: "message", target: "zoro",
      instruction: "review the login page" });
    assert.equal(handled[0].speakerId, "owner");
    assert.equal(handled[0].shouldAct(), true);
  });
});

test("an ordinary comma-led follow-up reaches the brain, not the session router", async () => {
  const handled = [];
  const ownerRouter = { reset() {}, sessionTags: async () => ["frankie"],
    handle: async (...args) => { handled.push(args); return "Wrong session action."; } };
  await withConversation({ ownerRouter }, async ({ events, brain }) => {
    events("turn_end", { text: "Actually, can you explain that again?" });
    await waitUntil(() => brain.asks.length === 1, "ordinary follow-up");
    assert.deepEqual(brain.asks, ["Actually, can you explain that again?"]);
    assert.equal(handled.length, 0);
  });
});

test("guest speech or an owner side address cancels a pending task", async () => {
  for (const interruption of ["guest", "side address"]) {
    const writes = [];
    const ownerRouter = { reset() {}, sessionTags: async () => ["zoro"],
      handle: async (_text, { shouldAct }) => {
        if (shouldAct()) writes.push("posted");
        return "I posted it.";
      } };
    await withConversation({ ownerRouter, dormant: true }, async ({ events, conversation }) => {
      events("turn_end", { text: "Jester, tell Zoro to review the page" });
      await tick();
      if (interruption === "guest") events("speech_start", { speaker: "guest" });
      else events("turn_end", { text: "Bob, how is your day?" });
      await tick();
      assert.equal(conversation.attention.engaged, false);
      await new Promise(resolve => setTimeout(resolve, 850));
      assert.deepEqual(writes, [], interruption);
      events("turn_end", { text: "Tell Zoro to edit files" });
      await tick();
      assert.deepEqual(writes, [], "a bare command cannot reopen the exchange");
    });
  }
});

test("dropped owner audio makes an otherwise valid task unsafe", async () => {
  let actions = 0;
  const ownerRouter = { reset() {}, sessionTags: async () => ["zoro"],
    handle: async () => { actions += 1; return "Posted."; } };
  await withConversation({ ownerRouter, dormant: true }, async ({ events, worker }) => {
    events("speech_start");
    worker.emit("drop", { speaker: "owner", reason: "input_queue_full" });
    events("turn_end", { text: "Jester, tell Zoro to review the page", incomplete: false });
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(actions, 0);
    assert.ok(worker.sent.some(item => item.op === "say" && /missed part/i.test(item.text)));
  });
});

test("just-listen cancels previously scheduled follow-on work", async () => {
  let canceled = 0;
  const ownerRouter = { reset() {}, sessionTags: async () => [],
    dependencies: { async cancelPending() { canceled++; } } };
  await withConversation({ ownerRouter }, async ({ events }) => {
    events("turn_end", { text: "Jester just listen" });
    await waitUntil(() => canceled === 1, "pending work cancellation");
  });
});

test("same-room process restart stays muted until Drew says talk again", async () => {
  const presence = Object.assign(new EventEmitter(), {
    async handleOwnerTurn() { return false; },
    clearRestoredPresence() { this.restoredCleared = true; },
  });
  await withConversation({ presence, dormant: true }, async ({ conversation, voice, events }) => {
    presence.emit("restoredPresence");
    assert.equal(conversation.mode, "transcript");
    assert.equal(voice.muted.at(-1), true);
    events("turn_end", { text: "Jester, talk again" });
    await tick();
    assert.equal(conversation.mode, "conversation");
    assert.equal(voice.muted.at(-1), false);
    assert.equal(conversation.attention.engaged, false);
    assert.equal(presence.restoredCleared, true);
  });
});

test("accepted first sentence reaches Kokoro while Luna is still composing later speech", async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  let releaseThird;
  const thirdReady = new Promise((resolve) => { releaseThird = resolve; });
  await withConversation({ brainAsk: async function* (text) {
    this.asks.push(text);
    yield "First sentence.";
    await secondReady;
    yield "Second sentence.";
    await thirdReady;
    yield "Third sentence.";
  } }, async ({ events, worker, voice, brain, conversation }) => {
    events("pause", { prob: 0.8, text: "Question" });
    await tick();
    assert.deepEqual(worker.sent.filter((message) => message.op === "say"), []);

    events("turn_end", { text: "Question?" });
    await tick();
    const first = worker.sent.find((message) => message.op === "say");
    assert.equal(first.text, "First sentence.");
    assert.deepEqual(brain.asks, ["Question"]);
    assert.equal(voice.played.length, 1);

    worker.emit("event", { ev: "say_done", id: first.id });
    assert.equal(conversation.reply.streamEnded, false);
    releaseSecond();
    await tick();
    const says = worker.sent.filter((message) => message.op === "say");
    assert.deepEqual(says.map((message) => message.text), ["First sentence.", "Second sentence."]);
    assert.equal(voice.played.length, 1);
    releaseThird();
    await tick();
    assert.equal(worker.sent.filter((message) => message.op === "say").length, 2);
    assert.equal(conversation.reply.text, "First sentence. Second sentence.");
    worker.emit("event", { ev: "say_done", id: says[1].id });
    const third = worker.sent.filter((message) => message.op === "say")[2];
    assert.equal(third.text, "Third sentence.");
    worker.emit("event", { ev: "say_done", id: third.id });
    assert.equal(conversation.reply.streamEnded, true);
  });
});

test("real Discord player audibly resumes after a slow gap between streamed sentences", async () => {
  const packets = [];
  const voice = createVoice({
    config: { guildId: "guild", voiceChannelId: "room", token: "unused" },
    client: { users: { cache: new Map() }, guilds: { cache: new Map() } },
  });
  const subscription = voice.player.subscribe({
    state: { status: "ready" },
    prepareAudioPacket(packet) { packets.push(Buffer.from(packet)); },
    dispatchAudio() {},
    setSpeaking() {},
  });
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  let brainFinished = false;
  try {
    await withConversation({ voice, brainAsk: async function* () {
      yield "First sentence.";
      await secondReady;
      yield "Second sentence.";
      brainFinished = true;
    } }, async ({ events, worker }) => {
      events("turn_end", { text: "Question?" });
      await waitUntil(() => worker.sent.some((message) => message.op === "say"), "first say");
      const first = worker.sent.find((message) => message.op === "say");
      worker.emit("event", { ev: "audio_out", id: first.id, pcm: speechPcm(3_000) });
      await waitUntil(() => packets.some((packet) => packet.length > 3), "first audible packet");
      assert.equal(brainFinished, false, "first audio plays before Luna completes");
      worker.emit("event", { ev: "say_done", id: first.id });

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.notEqual(voice.player.state.status, "idle", "player survives a gap longer than five missed frames");
      assert.ok(voice.playedMs(first.id) < 250, "gap silence does not count as words heard");
      const audibleBeforeSecond = packets.filter((packet) => packet.length > 3).length;

      releaseSecond();
      await waitUntil(() => worker.sent.filter((message) => message.op === "say").length === 2, "second say");
      const second = worker.sent.filter((message) => message.op === "say")[1];
      worker.emit("event", { ev: "audio_out", id: second.id, pcm: speechPcm(-3_000) });
      await waitUntil(() => packets.filter((packet) => packet.length > 3).length > audibleBeforeSecond, "second audible packet");
      worker.emit("event", { ev: "say_done", id: second.id });
      await waitUntil(() => voice.player.state.status === "idle", "completed playback");
    });
  } finally {
    releaseSecond();
    voice.stopNow();
    voice.player.unsubscribe(subscription);
  }
});

test("barge-in discards sentences that arrive after the first streamed sentence", async () => {
  let releaseLater;
  const laterReady = new Promise((resolve) => { releaseLater = resolve; });
  await withConversation({ brainAsk: async function* () {
    yield "First sentence.";
    await laterReady;
    yield "Stale sentence.";
  } }, async ({ events, worker, voice }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    const first = worker.sent.find((message) => message.op === "say");
    assert.equal(first.text, "First sentence.");
    events("speech_sustained", { voiced_ms: 1000 });
    releaseLater();
    await tick();
    assert.equal(voice.stopped, 1);
    assert.ok(worker.sent.some((message) => message.op === "cancel" && message.id === first.id));
    assert.deepEqual(worker.sent.filter((message) => message.op === "say").map((message) => message.text), ["First sentence."]);
  });
});

test("barge-in stops audio, cancels Kokoro, interrupts Luna, and records only estimated heard words", async () => {
  await withConversation({ answers: ["One two three four five."] }, async ({ events, worker, voice, brain, conversation, logPath }) => {
    events("turn_end", { text: "Question?", ms: { utterance: 500 } });
    await tick();
    const say = worker.sent.find((message) => message.op === "say");
    worker.emit("event", { ev: "audio_out", id: say.id, pcm: Buffer.alloc(4).toString("base64") });
    events("speech_sustained", { voiced_ms: 1000 });
    await tick();
    assert.equal(voice.stopped, 1);
    assert.ok(worker.sent.some((message) => message.op === "cancel" && message.id === say.id));
    assert.equal(brain.interrupts, 1);
    assert.deepEqual(brain.context, ["Jester said (heard): One"]);
    assert.equal(conversation.reply, null);
    assert.equal(heardWords("one two", 0), "");
  });
});

test("turn metrics are logged", async () => {
  await withConversation({ answers: ["A reply."] }, async ({ events, brain, voice, conversation, worker, logPath }) => {
    conversation.stallClip = Buffer.from([1, 2, 3, 4]);
    events("pause", { prob: 0.8, text: "Question" });
    events("turn_end", { text: "Question", ms: { utterance: 400 } });
    await tick();
    const say = worker.sent.find((message) => message.op === "say");
    worker.emit("event", { ev: "audio_out", id: say.id, pcm: Buffer.alloc(4).toString("base64") });
    worker.emit("event", { ev: "say_done", id: say.id });
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    await tick();
    const row = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.equal(row.type, "turn");
    assert.equal(row.sttMs, null);
    assert.equal(row.utteranceMs, 400);
    assert.ok("ttsFirstChunkMs" in row.timings);
  });
});

test("text merge avoids repeating the overlap", () => {
  assert.equal(mergeText("Tell me about", "about Luna."), "Tell me about Luna.");
});

test("addressed owner leave command is consumed by presence instead of sent to Luna", async () => {
  let left = 0;
  await withConversation({ presence: { async handleOwnerTurn(text) { left++; return text === "Jester, leave"; } } }, async ({ events, brain }) => {
    events("turn_end", { text: "Jester, leave" });
    await tick();
    assert.equal(left, 1);
    assert.deepEqual(brain.asks, []);
  });
});

test("a brain failure without a reason stays silent and never plays a cached clip", async () => {
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  let leaves = 0;
  const presence = { async handleOwnerTurn(text) { if (text === "Jester, leave") { leaves++; return true; } return false; } };
  await withConversation({
    brainAsk: async function* () { throw new Error("Codex unavailable"); },
    presence, transcript,
  }, async ({ events, worker, voice, conversation }) => {
    conversation.unavailableClip = Buffer.from([1, 2, 3, 4]);
    events("pause", { prob: 0.8, text: "Question" });
    await tick();
    events("turn_end", { text: "Question?" });
    await tick();
    assert.equal(voice.played.length, 0, "the pre-recorded clip path is retired");
    assert.equal(worker.sent.some(({ op }) => op === "say"), false, "no honest line without a detected reason");
    events("turn_end", { text: "Jester, leave" });
    await tick();
    assert.equal(leaves, 1, "deterministic leave control remains available after brain failure");
  });
});

test("room transcript captures guest turns and only the heard part of Jester replies", async () => {
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ answers: ["One two three four five."], transcript }, async ({ events, worker }) => {
    worker.emit("event", { ev: "turn_end", speaker: "guest", text: "A guest question." });
    events("turn_end", { text: "Jester, Owner question?" });
    await tick();
    events("speech_sustained", { voiced_ms: 1000 });
    await tick();
    assert.deepEqual(transcript.rows, [
      ["Guest Name", "A guest question."],
      ["owner", "Jester, Owner question?"],
      ["Jester", "One"],
    ]);
  });
});

test("voice disconnect drops stale input, resets worker speech state, and aborts the current reply", async () => {
  await withConversation({}, async ({ events, voice, worker, conversation }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    assert.ok(conversation.reply);
    voice.emit("disconnect");
    assert.equal(conversation.reply, null);
    assert.deepEqual(worker.dropped, ["owner", 0]);
    assert.ok(worker.sent.some((message) => message.op === "reset" && message.speaker === "owner"));
  });
});

test("recording pause discards buffered speech from every speaker", async () => {
  const presence = Object.assign(new EventEmitter(), { paused: false, handleOwnerTurn: async () => false });
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ presence, transcript }, async ({ events, worker, brain, voice, conversation }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    assert.ok(conversation.reply);
    presence.paused = true;
    presence.emit("capturePaused", ["owner", "guest"]);
    assert.equal(conversation.reply, null);
    assert.ok(voice.stopped > 0);
    assert.ok(worker.sent.some(message => message.op === "reset" && message.speaker === "guest"));
    worker.emit("event", { ev: "turn_end", speaker: "guest", text: "Private words" });
    events("turn_end", { text: "Jester, private words" });
    await tick();
    assert.equal(brain.asks.length, 1);
    assert.ok(!transcript.rows.some(([, text]) => text.includes("Private words")));
  });
});

// Advance real production deadlines without sleeping or using any live providers.
const flush = () => new Promise((resolve) => setImmediate(resolve));
function slowBrain() {
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  return {
    finish,
    async *ask(text, options) {
      this.asks.push({ text, ...options });
      await ready;
      yield "The answer.";
    },
  };
}

test("thinking cue waits 2500 ms after acceptance, ignores pause stalls, and plays only once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, worker, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2, 3, 4]);
    events("pause", { prob: 0.8, text: "Question" });
    await flush();
    t.mock.timers.tick(5000);
    brain.emit("thinking", { speaker: "owner" });
    assert.equal(voice.played.length, 0, "tentative pause stays silent");
    events("turn_end", { text: "Question?" });
    await flush();
    t.mock.timers.tick(2499);
    assert.equal(voice.played.length, 0, "speculation time cannot shorten the wait");
    t.mock.timers.tick(1);
    assert.deepEqual(voice.played.map(({ stream }) => stream), [conversation.stallClip]);
    assert.equal(worker.sent.length, 0, "cached PCM needs no synthesis");
    brain.emit("thinking", { speaker: "owner" });
    t.mock.timers.tick(10000);
    assert.equal(voice.played.length, 1, "one cue per accepted turn");
    slow.finish();
    await flush();
    assert.equal(voice.stopped, 1, "answer replaces the cue");
    assert.equal(worker.sent.find((message) => message.op === "say").text, "The answer.");
  });
});

test("a first word before a complete sentence suppresses the thinking cue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("turn_end", { text: "Question?" });
    await flush();
    t.mock.timers.tick(2000);
    brain.emit("firstWord", brain.asks[0]);
    t.mock.timers.tick(5000);
    assert.equal(voice.played.length, 0);
    slow.finish();
    await flush();
  });
});

test("words received during speculation suppress the cue after acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("pause", { prob: 0.8, text: "Question" });
    await flush();
    brain.emit("firstWord", brain.asks[0]);
    events("turn_end", { text: "Question?" });
    await flush();
    t.mock.timers.tick(5000);
    assert.equal(voice.played.length, 0);
    slow.finish();
    await flush();
  });
});

test("sustained speech immediately after turn_end prevents its pending cue and brain request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("turn_end", { text: "Interrupted question?" });
    events("speech_sustained", { voiced_ms: 1000 });
    await flush();
    t.mock.timers.tick(5000);
    assert.equal(voice.played.length, 0);
    assert.deepEqual(brain.asks, []);
    assert.equal(conversation.turn, null);
    slow.finish();
  });
});

for (const action of ["speech_sustained", "disconnect", "fatal", "close"]) {
  for (const cueStarted of [false, true]) {
    test(`${action} cancels ${cueStarted ? "playing" : "pending"} thinking cue and ignores late output`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const slow = slowBrain();
      await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, worker, conversation }) => {
        conversation.stallClip = Buffer.from([1, 2]);
        events("turn_end", { text: "Question?" });
        await flush();
        t.mock.timers.tick(cueStarted ? 2500 : 2499);
        if (action === "speech_sustained") events("speech_sustained", { voiced_ms: 1000 });
        else if (action === "disconnect") voice.emit("disconnect");
        else if (action === "fatal") worker.emit("fatal", new Error("offline test failure"));
        else await conversation.close();
        t.mock.timers.tick(10000);
        brain.emit("thinking", { speaker: "owner" });
        slow.finish();
        await flush();
        assert.equal(voice.played.length, cueStarted ? 1 : 0);
        assert.equal(voice.stopped, cueStarted ? 1 : 0);
        assert.equal(worker.sent.some((message) => message.op === "say"), false);
      });
    });
  }
}

test("an interrupted request cannot suppress or trigger a replacement turn's cue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("pause", { prob: 0.8, text: "First" });
    await flush();
    events("speech_start");
    events("turn_end", { text: "Second" });
    await flush();
    brain.emit("firstWord", brain.asks[0]);
    brain.emit("thinking", { speaker: "owner" });
    t.mock.timers.tick(2499);
    assert.equal(voice.played.length, 0);
    t.mock.timers.tick(1);
    assert.equal(voice.played.length, 1);
    assert.equal(conversation.turn.brainFirstWordAt, null);
    slow.finish();
    await flush();
  });
});

test("a brain turn that ends without words cannot leave a thinking cue pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await withConversation({ brainAsk: async function* () {}, now: () => Date.now() }, async ({ events, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("turn_end", { text: "Question?" });
    await flush();
    t.mock.timers.tick(5000);
    assert.equal(voice.played.length, 0);
    assert.equal(conversation.turn, null);
  });
});

test("dormant room speech and guest wake words are transcribed without any brain or audio request", async () => {
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ dormant: true, transcript }, async ({ events, worker, brain, voice, conversation }) => {
    for (const [speaker, text] of [["owner", "Dinner is ready"], ["owner", "Zoro, start the job"], ["guest", "Jester, tell me about Drew's work"]]) {
      events("speech_start", { speaker });
      events("pause", { speaker, text, prob: 0.9 });
      events("turn_end", { speaker, text });
      await flush();
    }
    assert.equal(transcript.rows.length, 3);
    assert.deepEqual(brain.asks, []);
    assert.deepEqual(worker.sent, []);
    assert.deepEqual(voice.played, []);
    assert.equal(conversation.attention.engaged, false);
    events("pause", { text: "Jester, can you help", prob: 0.9 });
    await flush();
    assert.deepEqual(brain.asks, [], "a tentative wake waits for turn acceptance");
    events("turn_end", { text: "Hey Jester, can you help?" });
    await flush();
    assert.deepEqual(brain.asks, ["Hey Jester, can you help?"]);
    events("speech_start");
    events("turn_end", { text: "And what about tomorrow?" });
    await flush();
    assert.equal(brain.asks.at(-1), "And what about tomorrow?");
  });
});

test("ambient speech does not extend the window and dormant tags stay out of Luna", async () => {
  let now = 0;
  await withConversation({ dormant: true, now: () => now, brainAsk: async function* (text) { this.asks.push(text); } }, async ({ events, brain, conversation }) => {
    events("turn_end", { text: "Jester, hello" });
    await flush();
    now = 40_000;
    events("pause", { text: "Hey Alex, dinner is ready", prob: 0.9 });
    events("turn_end", { text: "Hey Alex, dinner is ready" });
    await flush();
    now = 59_999;
    events("turn_end", { speaker: "guest", text: "Jester, answer me" });
    await flush();
    assert.equal(conversation.attention.engaged, false);
    now = 60_000;
    events("pause", { text: "Zoro, start working", prob: 0.9 });
    events("turn_end", { text: "Zoro, start working" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, hello"]);
    events("turn_end", { text: "Jester, explain it" });
    await flush();
    events("turn_end", { text: "That's all, thanks" });
    await flush();
    events("turn_end", { text: "A room comment" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, hello", "Jester, explain it"]);
  });
});

test("bare side addresses are transcribed without dispatch or refresh; hey follow-ups reach Luna", async () => {
  let now = 0;
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ dormant: true, transcript, now: () => now,
    brainAsk: async function* (text) { this.asks.push(text); } }, async ({ events, brain, worker, conversation }) => {
    events("turn_end", { text: "Jester, hello" });
    await flush();
    now = 50_000;
    events("speech_start");
    events("pause", { text: "Alex, pass the salt", prob: 0.9 });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, hello"], "side speech cannot start a speculative request");
    events("turn_end", { text: "Alex, pass the salt" });
    await flush();
    assert.deepEqual(transcript.rows.at(-1), ["owner", "Alex, pass the salt"]);
    assert.deepEqual(brain.asks, ["Jester, hello"]);
    assert.deepEqual(worker.sent, []);
    now = 60_000;
    assert.equal(conversation.attention.engaged, false, "side speech cannot extend attention");
    events("turn_end", { text: "Jester, explain this" });
    await flush();
    now = 110_000;
    events("speech_start");
    events("pause", { text: "Hey can you clarify that?", prob: 0.9 });
    await flush();
    assert.equal(brain.asks.at(-1), "Hey can you clarify that?");
    assert.equal(conversation.attention.until, 120_000, "a tentative follow-up cannot refresh attention");
    events("turn_end", { text: "Hey can you clarify that?" });
    await flush();
    assert.equal(conversation.attention.until, 170_000, "the accepted follow-up refreshes attention");
    events("speech_start");
    events("turn_end", { text: "Hey can you clarify that?" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, hello", "Jester, explain this",
      "Hey can you clarify that?", "Hey can you clarify that?"]);
    assert.deepEqual(transcript.rows.at(-1), ["owner", "Hey can you clarify that?"]);
  });
});

test("rejected final room speech discards speculative output and cannot play it later", async () => {
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask }, async ({ events, brain, worker, conversation }) => {
    events("pause", { prob: 0.9, text: "Can you help" });
    await flush();
    events("turn_end", { text: "Hey Alex, can you help me?" });
    await flush();
    slow.finish();
    await flush();
    assert.equal(brain.interrupts, 1);
    assert.equal(conversation.turn, null);
    assert.equal(worker.sent.some(({ op }) => op === "say"), false);
  });
});

test("a tentative follow-up cannot extend attention beyond a lull", async () => {
  let now = 0;
  await withConversation({ now: () => now }, async ({ events, worker, conversation }) => {
    now = 59_999;
    events("pause", { prob: 0.9, text: "Maybe" });
    await flush();
    now = 60_000;
    events("turn_end", { text: "Maybe" });
    await flush();
    assert.equal(conversation.turn, null);
    assert.equal(conversation.attention.engaged, false);
    assert.equal(worker.sent.some(({ op }) => op === "say"), false);
  });
});

test("finishing a long answer gives Drew a fresh follow-up window", async () => {
  let now = 0;
  await withConversation({ dormant: true, now: () => now }, async ({ events, voice, worker, brain }) => {
    events("turn_end", { text: "Jester, explain this" });
    await flush();
    now = 90_000;
    events("say_done", { id: worker.sent.find(({ op }) => op === "say").id });
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    now += 59_999;
    events("turn_end", { text: "And the second part?" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, explain this", "And the second part?"]);
  });
});

test("presence resets and transport disconnects re-arm attention and invalidate pending wakes", async () => {
  for (const reset of ["presence", "transport"]) {
    const presence = Object.assign(new EventEmitter(), { async handleOwnerTurn() { return false; } });
    await withConversation({ presence }, async ({ events, voice, brain, conversation }) => {
      events("turn_end", { text: "Jester, explain this" });
      if (reset === "presence") presence.emit("reset");
      else voice.emit("disconnect");
      await flush();
      events("turn_end", { text: "A new room comment" });
      await flush();
      assert.deepEqual(brain.asks, []);
      assert.equal(conversation.attention.engaged, false);
    });
  }
});

test("dormant owner leave works and a tentative leave never reaches Luna", async () => {
  let leaves = 0;
  const presence = { async handleOwnerTurn(text) { if (text === "Jester, leave") { leaves++; return true; } return false; } };
  await withConversation({ dormant: true, presence }, async ({ events, brain, conversation }) => {
    events("turn_end", { text: "Jester, leave" });
    await flush();
    conversation.attention.accept("Jester");
    events("pause", { text: "Jester, leave", prob: 0.9 });
    await flush();
    events("turn_end", { text: "Jester, leave" });
    await flush();
    assert.equal(leaves, 2);
    assert.deepEqual(brain.asks, []);
    assert.equal(conversation.attention.engaged, false);
  });
});

test("a resumed draft cannot hide an ending or use its old wake name after a lull", async () => {
  for (const text of ["That's all", "Hey Alex can you help", "Ordinary room talk"]) {
    let now = 0;
    await withConversation({ now: () => now }, async ({ events, brain, worker, conversation }) => {
      events("pause", { prob: 0.9, text: "Jester, maybe" });
      await flush();
      events("speech_start");
      if (text === "Ordinary room talk") now = 60_000;
      events("turn_end", { text });
      await flush();
      assert.deepEqual(brain.asks, ["Jester, maybe"]);
      assert.equal(conversation.turn, null);
      assert.equal(worker.sent.some(({ op }) => op === "say"), false);
    });
  }
});

test("just listen cancels current and queued speech while keeping every room turn in the transcript", async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  let leaves = 0;
  const presence = { async handleOwnerTurn(text) { if (text === "Jester, leave") { leaves++; return true; } return false; } };
  await withConversation({ dormant: true, transcript, presence,
    brainAsk: async function* (text) {
      this.asks.push(text);
      yield "First sentence.";
      await secondReady;
      yield "Queued sentence.";
    } }, async ({ events, brain, worker, voice, conversation }) => {
    events("turn_end", { text: "Jester, tell me something" });
    await flush();
    const first = worker.sent.find(({ op }) => op === "say");
    assert.equal(first.text, "First sentence.");
    events("speech_start");
    events("pause", { text: "Jester, just", prob: 0.9 });
    events("pause", { text: "Jester, just listen", prob: 0.9 });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, tell me something"]);
    events("turn_end", { text: "Jester, just listen" });
    await flush();
    assert.equal(conversation.mode, "transcript");
    assert.equal(voice.muted.at(-1), true);
    assert.equal(conversation.attention.engaged, false);
    assert.equal(conversation.reply, null);
    assert.ok(worker.sent.some(({ op, id }) => op === "cancel" && id === first.id));
    releaseSecond();
    await flush();
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text), ["First sentence."]);

    for (const [speaker, text] of [["owner", "Jester, what about tomorrow?"],
      ["guest", "Jester, talk again"], ["guest", "Zoro, do the work"], ["owner", "Zoro, start working"]]) {
      events("speech_start", { speaker });
      events("pause", { speaker, text, prob: 0.9 });
      events("turn_end", { speaker, text });
      await flush();
    }
    assert.equal(conversation.mode, "transcript");
    assert.deepEqual(brain.asks, ["Jester, tell me something"]);
    assert.deepEqual(transcript.rows.slice(-5), [
      ["owner", "Jester, just listen"], ["owner", "Jester, what about tomorrow?"],
      ["Guest Name", "Jester, talk again"], ["Guest Name", "Zoro, do the work"],
      ["owner", "Zoro, start working"],
    ]);
    events("turn_end", { text: "Jester, leave" });
    await flush();
    assert.equal(leaves, 1, "owner leave remains available in transcript mode");
    assert.equal(voice.played.length, 1);
  });
});

test("talk again restores dormant conversation and owner presence resets transcript mode", async () => {
  const presence = Object.assign(new EventEmitter(), { async handleOwnerTurn() { return false; } });
  await withConversation({ dormant: true, presence,
    brainAsk: async function* (text) { this.asks.push(text); } }, async ({ events, brain, voice, conversation }) => {
    events("turn_end", { text: "Jester, just listen" });
    await flush();
    assert.equal(conversation.mode, "transcript");
    voice.emit("disconnect");
    presence.emit("reset"); // a transport reconnect in the same owner visit
    assert.equal(conversation.mode, "transcript");
    events("turn_end", { text: "Jester, talk again" });
    await flush();
    assert.equal(conversation.mode, "conversation");
    assert.equal(voice.muted.at(-1), false);
    assert.equal(conversation.attention.engaged, false);
    events("turn_end", { text: "What did I miss?" });
    await flush();
    assert.deepEqual(brain.asks, []);
    events("turn_end", { text: "Jester, what did I miss?" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, what did I miss?"]);

    events("turn_end", { text: "Jester, just listen" });
    await flush();
    assert.equal(conversation.mode, "transcript");
    presence.emit("reset", "owner_departed");
    presence.emit("reset"); // new join
    assert.equal(conversation.mode, "conversation");
    assert.equal(conversation.attention.engaged, false);
    events("turn_end", { text: "Unaddressed room talk" });
    await flush();
    assert.deepEqual(brain.asks, ["Jester, what did I miss?"]);
  });
});

test("a final just-listen command itself stops an active reply and any later sentence", async () => {
  let releaseLater;
  const laterReady = new Promise((resolve) => { releaseLater = resolve; });
  await withConversation({ brainAsk: async function* (text) {
    this.asks.push(text);
    yield "First sentence.";
    await laterReady;
    yield "Never speak this.";
  } }, async ({ events, worker, voice, brain, conversation }) => {
    events("turn_end", { text: "Tell me something" });
    await flush();
    const first = worker.sent.find(({ op }) => op === "say");
    assert.ok(first);
    // The real worker emits speech_start first; this also protects the control
    // if the final transcript arrives without that preliminary event.
    events("turn_end", { text: "Jester, just listen" });
    await flush();
    assert.equal(conversation.mode, "transcript");
    assert.equal(conversation.reply, null);
    assert.equal(voice.stopped, 1);
    assert.ok(worker.sent.some(({ op, id }) => op === "cancel" && id === first.id));
    releaseLater();
    await flush();
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text), ["First sentence."]);
    assert.deepEqual(brain.asks, ["Tell me something"]);
  });
});

test("tentative mode commands stay local even during an engaged exchange", async () => {
  await withConversation({ brainAsk: async function* (text) { this.asks.push(text); } }, async ({ events, brain, worker, conversation }) => {
    events("pause", { text: "Jester, just", prob: 0.9 });
    await flush();
    assert.deepEqual(brain.asks, []);
    events("turn_end", { text: "Jester, just listen" });
    await flush();
    assert.equal(conversation.mode, "transcript");
    events("pause", { text: "Jester, talk aga", prob: 0.9 });
    events("turn_end", { text: "Jester, talk again" });
    await flush();
    assert.deepEqual(brain.asks, []);
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say"), []);
    assert.equal(conversation.mode, "conversation");
  });
});

test("a stalled player drops the reply once 8 MB of speech is pending", async () => {
  await withConversation({ answers: ["A long reply."] }, async ({ events, worker, voice, brain, conversation }) => {
    voice.playedMs = () => 0; // Discord playback has stalled.
    events("turn_end", { text: "Question?", ms: { utterance: 400 } });
    await tick();
    const say = worker.sent.find((message) => message.op === "say");
    const chunk = Buffer.alloc(1024 * 1024).toString("base64");
    let written = 0;
    for (let i = 0; i < 9 && conversation.reply; i += 1) {
      worker.emit("event", { ev: "audio_out", id: say.id, pcm: chunk });
      if (conversation.reply) written += 1;
    }
    await tick();
    assert.equal(conversation.reply, null, "the reply is dropped, not buffered without bound");
    assert.ok(written <= 8, `at most 8 MB reached the player (${written} MB)`);
    assert.ok(voice.stopped >= 1);
    assert.ok(brain.interrupts >= 1);
  });
});

// ---- J1: no cut-out on noises, model-free answers, honest brain-out line, fresh tags ----

async function logRows(conversation, logPath) {
  await conversation.logQueue;
  try { return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

function heldBrain(first = "First sentence.", later = "Later sentence.") {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return {
    release,
    async *ask(text) { this.asks.push(text); yield first; await ready; yield later; },
  };
}

test("a short owner speech_start no longer stops a playing reply or interrupts Luna", async () => {
  await withConversation({ answers: ["One two three."] }, async ({ events, worker, voice, brain, conversation }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    assert.ok(conversation.reply);
    events("speech_start");
    await tick();
    assert.equal(voice.stopped, 0);
    assert.equal(brain.interrupts, 0);
    assert.ok(conversation.reply, "the reply keeps playing");
    assert.equal(worker.sent.some(({ op }) => op === "cancel"), false);
  });
});

test("sustained owner speech stops the reply and interrupts Luna", async () => {
  await withConversation({ answers: ["One two three."] }, async ({ events, worker, voice, brain, conversation }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    const say = worker.sent.find(({ op }) => op === "say");
    events("speech_start");
    events("speech_sustained", { voiced_ms: 1000 });
    await tick();
    assert.equal(voice.stopped, 1);
    assert.equal(brain.interrupts, 1);
    assert.ok(worker.sent.some(({ op, id }) => op === "cancel" && id === say.id));
    assert.equal(conversation.reply, null);
  });
});

test("a backchannel while Jester talks is neither a stop nor a turn nor a transcript line", async () => {
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ answers: ["One two three."], transcript }, async ({ events, worker, voice, brain, conversation, logPath }) => {
    events("turn_end", { text: "Question?" });
    await tick();
    events("speech_start");
    events("pause", { prob: 0.9, text: "Mm-hmm." });
    events("turn_end", { text: "Mm-hmm.", voiced_ms: 300 });
    await tick();
    assert.equal(voice.stopped, 0);
    assert.equal(worker.sent.some(({ op }) => op === "cancel"), false);
    assert.deepEqual(brain.asks, ["Question?"]);
    assert.deepEqual(brain.context, []);
    assert.equal(brain.interrupts, 0);
    assert.ok(conversation.reply, "the reply keeps playing");
    assert.ok(!transcript.rows.some(([, text]) => /mm-hmm/i.test(text)));
    const rows = await logRows(conversation, logPath);
    assert.ok(rows.some(row => row.type === "backchannel_ignored" && row.text === "Mm-hmm."));
  });
});

test("an idle backchannel starts no draft and reaches no brain", async () => {
  await withConversation({}, async ({ events, worker, brain }) => {
    for (const text of ["Mm-hmm.", "Uh-huh.", "Hmm.", "Yeah.", "Okay."]) {
      events("pause", { prob: 0.9, text });
      events("turn_end", { text });
      await tick();
    }
    assert.deepEqual(brain.asks, []);
    assert.equal(brain.interrupts, 0);
    assert.equal(worker.sent.some(({ op }) => op === "say"), false);
  });
});

test("an accepted turn awaiting Luna survives a hum and its sentences play", async () => {
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask }, async ({ events, worker, brain }) => {
    events("turn_end", { text: "Question?" });
    await flush();
    events("speech_start");
    events("pause", { prob: 0.9, text: "Hmm." });
    events("turn_end", { text: "Hmm." });
    await flush();
    slow.finish();
    await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "reply");
    assert.equal(brain.interrupts, 0);
    assert.equal(worker.sent.find(({ op }) => op === "say").text, "The answer.");
  });
});

test("a stop phrase at the pause stops the reply and Luna at once and asks nothing", async () => {
  const held = heldBrain();
  await withConversation({ brainAsk: held.ask }, async ({ events, worker, voice, brain, conversation }) => {
    events("turn_end", { text: "Tell me a story" });
    await tick();
    const say = worker.sent.find(({ op }) => op === "say");
    events("speech_start");
    events("pause", { prob: 0.9, text: "Jester, stop." });
    assert.equal(voice.stopped, 1, "stopped in the same event");
    assert.ok(worker.sent.some(({ op, id }) => op === "cancel" && id === say.id));
    assert.equal(brain.interrupts, 1);
    events("turn_end", { text: "Jester, stop." });
    held.release();
    await tick();
    assert.deepEqual(brain.asks, ["Tell me a story"]);
    assert.equal(conversation.attention.engaged, true);
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text), ["First sentence."]);
  });
});

test("a stop phrase with nothing playing is ignored", async () => {
  await withConversation({}, async ({ events, voice, brain, conversation }) => {
    events("pause", { prob: 0.9, text: "Stop." });
    events("turn_end", { text: "Stop." });
    await tick();
    assert.equal(voice.stopped, 0);
    assert.deepEqual(brain.asks, []);
    assert.equal(conversation.attention.engaged, true);
  });
});

test("real words while a reply plays stop it and interrupt Luna before the new turn", async () => {
  const order = [];
  const held = heldBrain();
  await withConversation({ brainAsk: async function* (text) {
    order.push(`ask:${text}`);
    yield* held.ask.call(this, text);
  } }, async ({ events, worker, voice, brain }) => {
    brain.interrupt = async () => { brain.interrupts += 1; order.push("interrupt"); };
    events("turn_end", { text: "Is podlox open?" });
    await tick();
    const say = worker.sent.find(({ op }) => op === "say");
    events("turn_end", { text: "No, pod locks." });
    await tick();
    assert.equal(voice.stopped, 1);
    assert.ok(worker.sent.some(({ op, id }) => op === "cancel" && id === say.id));
    assert.deepEqual(order, ["ask:Is podlox open?", "interrupt", "ask:No, pod locks."]);
    held.release();
  });
});

test("a bare yes right after Jester asked a question is an answer", async () => {
  await withConversation({ answers: ["Shall I check it?", "Checking."] }, async ({ events, worker, voice, brain }) => {
    events("turn_end", { text: "Is podlox done?" });
    await tick();
    events("say_done", { id: worker.sent.find(({ op }) => op === "say").id });
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    events("turn_end", { text: "Yeah." });
    await tick();
    assert.deepEqual(brain.asks, ["Is podlox done?", "Yeah."]);
  });
});

test("prefix uses of yeah are ordinary turns", async () => {
  await withConversation({ brainAsk: async function* (text) { this.asks.push(text); } }, async ({ events, brain }) => {
    events("turn_end", { text: "Yeah, so I need you to check Zoro" });
    await tick();
    events("turn_end", { text: "Uh yeah, open a thread in the jobs folder" });
    await tick();
    assert.deepEqual(brain.asks, ["Yeah, so I need you to check Zoro",
      "Uh yeah, open a thread in the jobs folder"]);
  });
});

test("list, see, why-no-tag and find questions are answered by the router without Luna", async () => {
  const handled = [];
  const ownerRouter = { reset() {}, sessionTags: async () => [],
    handle: async (text, options) => { handled.push(options.intent.kind); return `Answer for ${text}`; } };
  await withConversation({ ownerRouter }, async ({ events, worker, brain }) => {
    const texts = ["what's open?", "do you see pod locks?", "how come there's no tag on podlox?",
      "find the login work"];
    for (const [index, text] of texts.entries()) {
      events("turn_end", { text });
      await waitUntil(() => worker.sent.filter(({ op }) => op === "say").length === index + 1, text);
    }
    assert.deepEqual(handled, ["list-open", "see-one", "why-no-tag", "history"]);
    assert.deepEqual(brain.asks, []);
    assert.equal(worker.sent.filter(({ op }) => op === "say")[0].text, "Answer for what's open?");
  });
});

test("a brain failure with a reason speaks the honest line once and logs it", async () => {
  const error = Object.assign(new Error("usage limit"), { reason: "usageLimitExceeded", brain: "codex" });
  await withConversation({ brainAsk: async function* () { throw error; } }, async ({ events, worker, voice, conversation, logPath }) => {
    conversation.unavailableClip = Buffer.from([1, 2, 3, 4]);
    events("turn_end", { text: "Question?" });
    await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "honest line");
    await tick();
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text), [BRAIN_OUT_LINE]);
    assert.ok(voice.played.every(({ stream }) => !Buffer.isBuffer(stream)), "no cached clip");
    const rows = await logRows(conversation, logPath);
    assert.ok(rows.some(row => row.type === "brain_error" && row.reason === "usageLimitExceeded" &&
      row.brain === "codex"));
  });
});

test("a brain failure after the first sentence speaks the honest line after it", async () => {
  const error = Object.assign(new Error("dropped"), { reason: "unreachable" });
  await withConversation({ brainAsk: async function* () { yield "First sentence."; throw error; } },
    async ({ events, worker, voice, conversation }) => {
      events("turn_end", { text: "Question?" });
      await waitUntil(() => conversation.reply?.brainDone, "brain failure");
      events("say_done", { id: worker.sent.find(({ op }) => op === "say").id });
      voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
      assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text),
        ["First sentence.", BRAIN_OUT_LINE]);
    });
});

test("a status question with the brain down speaks the router's status sentence", async () => {
  const calls = [];
  const ownerRouter = { reset() {}, sessionTags: async () => ["nami"],
    readContext: async () => ({ kind: "context", text: "Nami transcript" }),
    statusSentence: async (intent, options) => { calls.push([intent.kind, options]); return "Nami is running tests."; },
    handle: async () => "wrong path" };
  const error = Object.assign(new Error("quota"), { reason: "usageLimitExceeded", brain: "claude" });
  await withConversation({ ownerRouter, brainAsk: async function* () { throw error; } }, async ({ events, worker }) => {
    events("turn_end", { text: "Jester, what is Nami doing?" });
    await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "status sentence");
    await tick();
    assert.deepEqual(worker.sent.filter(({ op }) => op === "say").map(({ text }) => text), ["Nami is running tests."]);
    assert.deepEqual(calls, [["status-one", { allowReference: true }]]);
  });
});

test("session tags refresh on engaged turns so a new session is addressable without restart", async () => {
  let tags = [];
  let calls = 0;
  const handled = [];
  const ownerRouter = { reset() {}, sessionTags: async () => { calls += 1; return tags; },
    handle: async (_text, options) => { handled.push(options.intent); return "Posted."; } };
  await withConversation({ ownerRouter, brainAsk: async function* (text) { this.asks.push(text); } },
    async ({ events, brain }) => {
      await tick();
      const atStart = calls;
      events("turn_end", { text: "tell me a joke" });
      await waitUntil(() => brain.asks.length === 1, "plain turn");
      assert.ok(calls > atStart, "a plain engaged turn refreshes tags");
      tags = ["zoro"];
      events("turn_end", { text: "Zoro, check the tests" });
      await waitUntil(() => handled.length === 1, "message route");
      assert.equal(handled[0].kind, "message");
      assert.equal(handled[0].target, "Zoro");
    });
});

test("a voice create refreshes session tags afterwards", async () => {
  let calls = 0;
  const ownerRouter = { reset() {}, sessionTags: async () => { calls += 1; return []; },
    handle: async () => "Created podlox." };
  await withConversation({ ownerRouter }, async ({ events, worker }) => {
    events("turn_end", { text: "Jester, open a new session in podlox to fix the build" });
    await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "create receipt");
    await tick();
    // One call at start, one for the engaged turn, and one after the create.
    assert.ok(calls >= 3, `tags refreshed after create (${calls})`);
  });
});

test("a failing snapshot warns and keeps the previous tags", async () => {
  let fail = false;
  const warnings = [];
  const ownerRouter = { reset() {}, handle: async () => "ok",
    sessionTags: async () => { if (fail) throw new Error("EBI down"); return ["zoro"]; } };
  const logger = { warn: (...args) => warnings.push(args.join(" ")) };
  await withConversation({ ownerRouter, logger, brainAsk: async function* (text) { this.asks.push(text); } },
    async ({ events, conversation, brain }) => {
      await tick();
      assert.ok(conversation.attention.sessionTags.has("zoro"));
      fail = true;
      events("turn_end", { text: "tell me a joke" });
      await waitUntil(() => brain.asks.length === 1, "turn");
      await tick();
      assert.ok(warnings.some(text => /EBI down/.test(text)));
      assert.ok(conversation.attention.sessionTags.has("zoro"));
    });
});

test("Jester never speaks a filler sentence", async () => {
  await withConversation({ brainAsk: async function* () { yield "Mm-hmm."; yield "I'm here."; } },
    async ({ events, worker }) => {
      events("turn_end", { text: "Are you there?" });
      await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "reply");
      assert.equal(worker.sent.find(({ op }) => op === "say").text, "I'm here.");
    });
});

test("turn rows record the owner's words and speech metrics", async () => {
  await withConversation({ answers: ["A reply."] }, async ({ events, worker, voice, conversation, logPath }) => {
    events("turn_end", { text: "Question?", voiced_ms: 820, vad_mean: 0.71, stt_logprob: -0.2 });
    await tick();
    events("say_done", { id: worker.sent.find(({ op }) => op === "say").id });
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    const row = (await logRows(conversation, logPath)).find(({ type }) => type === "turn");
    assert.equal(row.ownerText, "Question?");
    assert.equal(row.voiced_ms, 820);
    assert.equal(row.vad_mean, 0.71);
    assert.equal(row.stt_logprob, -0.2);
  });
});

test("logEvent writes a row with its own type to the turn log", async () => {
  await withConversation({}, async ({ conversation, logPath }) => {
    conversation.logEvent({ type: "brainSwitched", from: "codex", to: "claude", reason: "usageLimitExceeded" });
    const rows = await logRows(conversation, logPath);
    assert.deepEqual(rows.filter(row => row.type === "brainSwitched").map(({ from, to, reason }) => ({ from, to, reason })),
      [{ from: "codex", to: "claude", reason: "usageLimitExceeded" }]);
  });
});
