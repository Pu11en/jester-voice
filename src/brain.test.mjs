import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Brain } from "./brain.mjs";

const fakeServer = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const makeBrain = (options = {}) => new Brain({
  command: fakeServer,
  args: [],
  requestTimeoutMs: 2_000,
  turnTimeoutMs: 2_000,
  ...options,
});

test("prewarms one thread and yields streamed sentences", async () => {
  const brain = makeBrain();
  try {
    assert.equal(await brain.prewarm(), "fake-thread");
    assert.equal(await brain.prewarm(), "fake-thread");
    const firstWords = [];
    brain.on("firstWord", (event) => firstWords.push(event));
    const sentences = [];
    for await (const sentence of brain.ask("Hi", { speaker: "owner", requestId: "voice-turn-1" })) sentences.push(sentence);
    assert.deepEqual(sentences, ["Hello there.", "How can I help?"]);
    assert.equal(firstWords.length, 1);
    assert.equal(firstWords[0].requestId, "voice-turn-1");
    assert.equal(firstWords[0].speaker, "owner");
  } finally {
    await brain.close();
  }
});

test("injectContext is included with the next ask without starting an extra turn", async () => {
  const brain = makeBrain();
  try {
    await brain.prewarm();
    brain.injectContext("Jester said: heard before");
    const sentences = [];
    for await (const sentence of brain.ask("What did you say?")) sentences.push(sentence);
    assert.deepEqual(sentences, ["Context kept."]);
  } finally {
    await brain.close();
  }
});

test("emits thinking after the configured stall interval", async () => {
  const brain = makeBrain({ stallMs: 15 });
  try {
    await brain.prewarm();
    const thinking = once(brain, "thinking");
    const response = (async () => {
      for await (const _sentence of brain.ask("delayed reply")) { /* drain */ }
    })();
    const [event] = await thinking;
    assert.equal(event.threadId, "fake-thread");
    await response;
  } finally {
    await brain.close();
  }
});

test("interrupt stops the active turn and drops its unfinished sentence", async () => {
  const brain = makeBrain();
  try {
    await brain.prewarm();
    const iterator = brain.ask("long reply")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: "Starting now.", done: false });
    assert.equal(await brain.interrupt(), true);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.equal(await brain.interrupt(), false);
  } finally {
    await brain.close();
  }
});

test("a hung turn kills the stale app-server and the next owner turn starts cleanly", async () => {
  const brain = makeBrain({ turnTimeoutMs: 30, restartBaseMs: 1, restartMaxMs: 2 });
  try {
    await assert.rejects(async () => {
      for await (const _sentence of brain.ask("hang forever")) { /* drain */ }
    }, /timed out/);
    assert.equal(brain.child, null);
    const sentences = [];
    for await (const sentence of brain.ask("next turn")) sentences.push(sentence);
    assert.deepEqual(sentences, ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});
