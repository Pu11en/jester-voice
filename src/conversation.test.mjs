import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Conversation, heardWords, mergeText } from "./conversation.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup({ answers = ["A reply."] } = {}) {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.send = (message) => worker.sent.push(message);
  const brain = new EventEmitter();
  brain.asks = [];
  brain.context = [];
  brain.interrupts = 0;
  brain.ask = async function* (text) {
    this.asks.push(text);
    const answer = answers.shift() || "Merged reply.";
    yield answer;
  };
  brain.interrupt = async () => { brain.interrupts += 1; };
  brain.injectContext = (text) => brain.context.push(text);
  const player = new EventEmitter();
  const voice = {
    player,
    played: [],
    stopped: 0,
    play(id, stream) { this.played.push({ id, stream }); },
    stopNow() { this.stopped += 1; },
    playedMs() { return 600; },
  };
  const events = (ev, payload = {}) => worker.emit("event", { ev, speaker: "owner", ...payload });
  return { worker, brain, voice, events };
}

async function withConversation(options, fn) {
  const dir = await mkdtemp(join(tmpdir(), "jester-conversation-"));
  const parts = setup(options);
  const conversation = new Conversation({ ...parts, ownerId: "owner", logFile: join(dir, "turns.jsonl") });
  conversation.start();
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

test("stall cue plays the cached clip and turn metrics are logged", async () => {
  await withConversation({ answers: ["A reply."] }, async ({ events, brain, voice, conversation, worker, logPath }) => {
    conversation.stallClip = Buffer.from([1, 2, 3, 4]);
    events("pause", { prob: 0.8, text: "Question" });
    brain.emit("thinking", { speaker: "owner" });
    assert.deepEqual(voice.played[0].stream, Buffer.from([1, 2, 3, 4]));
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
