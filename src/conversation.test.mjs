import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Conversation, heardWords, mergeText } from "./conversation.mjs";
import { createVoice } from "./voice.mjs";

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
    ownerRouter: options.ownerRouter, logFile: join(dir, "turns.jsonl") });
  conversation.start();
  // Existing playback/timing tests exercise an already engaged exchange.
  // Attention regressions below use dormant: true and wake through worker events.
  if (!options.dormant) conversation.attention.accept("Jester");
  try { await fn({ ...parts, conversation, logPath: join(dir, "turns.jsonl") }); }
  finally { await conversation.close(); await rm(dir, { recursive: true, force: true }); }
}

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

test("just-listen cancels previously scheduled follow-on work", async () => {
  let canceled = 0;
  const ownerRouter = { reset() {}, sessionTags: async () => [],
    dependencies: { async cancelPending() { canceled++; } } };
  await withConversation({ ownerRouter }, async ({ events }) => {
    events("turn_end", { text: "Jester just listen" });
    await waitUntil(() => canceled === 1, "pending work cancellation");
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
    events("speech_start");
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
    events("speech_start");
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

test("brain failure waits for turn acceptance, plays the cached notice, and preserves owner leave", async () => {
  const clip = Buffer.from([1, 2, 3, 4]);
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  let leaves = 0;
  const presence = { async handleOwnerTurn(text) { if (text === "Jester, leave") { leaves++; return true; } return false; } };
  await withConversation({
    brainAsk: async function* () { throw new Error("Codex unavailable"); },
    presence,
    transcript,
  }, async ({ events, worker, voice, conversation }) => {
    conversation.unavailableClip = clip;
    events("pause", { prob: 0.8, text: "Question" });
    await tick();
    assert.equal(voice.played.length, 0, "a speculative failure does not speak before turn acceptance");

    events("turn_end", { text: "Question?" });
    await tick();
    assert.equal(voice.played.length, 1);
    assert.deepEqual(voice.played[0].stream, clip);
    assert.equal(worker.sent.some((message) => message.op === "say"), false, "the fallback uses cached audio, not Kokoro or Luna");
    assert.deepEqual(transcript.rows, [["owner", "Question?"]], "unplayed audio is not transcribed");
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    assert.deepEqual(transcript.rows.at(-1), ["Jester", "I can't reach Luna right now. My voice controls still work."]);

    events("turn_end", { text: "Jester, leave" });
    await tick();
    assert.equal(leaves, 1, "deterministic leave control remains available after brain failure");
  });
});

test("owner speech interrupts the cached unavailable notice", async () => {
  const clip = Buffer.from([1, 2, 3, 4]);
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ brainAsk: async function* () { throw new Error("Codex unavailable"); }, transcript }, async ({ events, voice, conversation }) => {
    conversation.unavailableClip = clip;
    events("turn_end", { text: "Question?" });
    await tick();
    assert.equal(voice.played.length, 1);
    events("speech_start");
    assert.equal(voice.stopped, 1);
    assert.equal(conversation.localClipId, null);
    assert.deepEqual(transcript.rows.at(-1), ["Jester", "I"]);
  });
});

test("a Luna failure after its first sentence plays the cached notice after that sentence", async () => {
  const clip = Buffer.from([1, 2, 3, 4]);
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({
    brainAsk: async function* () { yield "First sentence."; throw new Error("Luna dropped out"); },
    transcript,
  }, async ({ events, worker, voice, conversation }) => {
    conversation.unavailableClip = clip;
    events("turn_end", { text: "Question?" });
    await waitUntil(() => worker.sent.some(({ op }) => op === "say"), "first sentence");
    await waitUntil(() => conversation.reply?.brainDone, "brain failure");
    assert.equal(voice.played.length, 1, "notice waits for spoken sentence to finish");
    const sayId = worker.sent.find(({ op }) => op === "say").id;
    events("say_done", { id: sayId });
    assert.equal(conversation.reply.streamEnded, true);
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    assert.equal(voice.played.length, 2);
    assert.deepEqual(voice.played[1].stream, clip);
    assert.deepEqual(transcript.rows, [["owner", "Question?"], ["Jester", "First"]]);
    voice.player.emit("stateChange", { status: "playing" }, { status: "idle" });
    assert.deepEqual(transcript.rows.at(-1), ["Jester", "I can't reach Luna right now. My voice controls still work."]);
  });
});

test("room transcript captures guest turns and only the heard part of Jester replies", async () => {
  const transcript = { rows: [], record(...row) { this.rows.push(row); } };
  await withConversation({ answers: ["One two three four five."], transcript }, async ({ events, worker }) => {
    worker.emit("event", { ev: "turn_end", speaker: "guest", text: "A guest question." });
    events("turn_end", { text: "Owner question?" });
    await tick();
    events("speech_start");
    await tick();
    assert.deepEqual(transcript.rows, [
      ["Guest Name", "A guest question."],
      ["owner", "Owner question?"],
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

test("speech starting immediately after turn_end prevents its pending cue and brain request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = slowBrain();
  await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, conversation }) => {
    conversation.stallClip = Buffer.from([1, 2]);
    events("turn_end", { text: "Interrupted question?" });
    events("speech_start");
    await flush();
    t.mock.timers.tick(5000);
    assert.equal(voice.played.length, 0);
    assert.deepEqual(brain.asks, []);
    assert.equal(conversation.turn, null);
    slow.finish();
  });
});

for (const action of ["speech_start", "disconnect", "fatal", "close"]) {
  for (const cueStarted of [false, true]) {
    test(`${action} cancels ${cueStarted ? "playing" : "pending"} thinking cue and ignores late output`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const slow = slowBrain();
      await withConversation({ brainAsk: slow.ask, now: () => Date.now() }, async ({ events, brain, voice, worker, conversation }) => {
        conversation.stallClip = Buffer.from([1, 2]);
        events("turn_end", { text: "Question?" });
        await flush();
        t.mock.timers.tick(cueStarted ? 2500 : 2499);
        if (action === "speech_start") events("speech_start");
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
    assert.equal(conversation.attention.engaged, true);
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
