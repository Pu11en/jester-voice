import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Brain, JESTER_INSTRUCTIONS, createSentenceStream, isUsageLimitText } from "./brain.mjs";

const fakeServer = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const makeBrain = (options = {}) => new Brain({
  command: fakeServer,
  args: [],
  requestTimeoutMs: 2_000,
  turnTimeoutMs: 2_000,
  ...options,
});
const drain = async (iterable) => {
  const sentences = [];
  for await (const sentence of iterable) sentences.push(sentence);
  return sentences;
};

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

test("a failed turn/completed rejects with the reason from codexErrorInfo and the brain stays usable", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("failed turn")), (error) => {
      assert.equal(error.reason, "contextWindowExceeded");
      assert.match(error.message, /context window/i);
      return true;
    });
    await assert.rejects(drain(brain.ask("failed turn plain")), (error) => {
      assert.equal(error.reason, "failed");
      return true;
    });
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("a nested error notification with codexErrorInfo usageLimitExceeded rejects with that reason", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("nested error")), (error) => {
      assert.equal(error.reason, "usageLimitExceeded");
      assert.equal(error.message, "You've hit your usage limit.");
      return true;
    });
  } finally {
    await brain.close();
  }
});

test("an error the server will retry does not abort the turn", async () => {
  const brain = makeBrain();
  try {
    assert.deepEqual(await drain(brain.ask("retrying error")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("usage-limit text streamed as content is rejected instead of spoken", async () => {
  const brain = makeBrain();
  try {
    const spoken = [];
    await assert.rejects((async () => {
      for await (const sentence of brain.ask("streamed limit")) spoken.push(sentence);
    })(), (error) => {
      assert.equal(error.reason, "usageLimitExceeded");
      return true;
    });
    assert.deepEqual(spoken, []);
  } finally {
    await brain.close();
  }
});

test("a rejected turn/start carries a text-derived usage-limit reason", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("rejected start")), (error) => {
      assert.equal(error.reason, "usageLimitExceeded");
      assert.match(error.message, /rate limit/i);
      return true;
    });
  } finally {
    await brain.close();
  }
});

test("isUsageLimitText recognises limit notices and ignores ordinary replies", () => {
  for (const text of ["You've hit your usage limit. Try again at 3 PM.", "Usage limit reached",
    "Rate limit exceeded for gpt-6-luna", "usage_limit_reached", "You exceeded your current quota"]) {
    assert.equal(isUsageLimitText(text), true, text);
  }
  for (const text of ["Hello there.", "The podlox thread is open.", "", null]) {
    assert.equal(isUsageLimitText(text), false, String(text));
  }
});

test("a leading backchannel is stripped and a filler-only reply yields nothing", async () => {
  const brain = makeBrain();
  try {
    assert.deepEqual(await drain(brain.ask("filler reply")), ["I'm here when you're ready."]);
    assert.deepEqual(await drain(brain.ask("only filler")), []);
    assert.deepEqual(await drain(brain.ask("comma filler")), ["That works."]);
    assert.deepEqual(await drain(brain.ask("filler reply", { whole: true })), ["I'm here when you're ready."]);
  } finally {
    await brain.close();
  }
});

test("JESTER_INSTRUCTIONS forbids opening with a filler or backchannel", () => {
  assert.match(JESTER_INSTRUCTIONS, /never open with a filler or backchannel/i);
  assert.match(JESTER_INSTRUCTIONS, /mm-hmm/i);
  assert.match(JESTER_INSTRUCTIONS, /start with the answer/i);
});

test("the stalled-turn timeout defaults near ten seconds and is injectable", () => {
  assert.equal(new Brain().turnTimeoutMs, 10_000);
  assert.equal(new Brain({ turnTimeoutMs: 1_234 }).turnTimeoutMs, 1_234);
});

test("a hanging turn rejects with reason timeout at the injected timeout and the fatal error carries it", async () => {
  const brain = makeBrain({ turnTimeoutMs: 30, restartBaseMs: 1, restartMaxMs: 2 });
  try {
    const fatal = once(brain, "fatal");
    const startedAt = Date.now();
    await assert.rejects(drain(brain.ask("hang forever")), (error) => {
      assert.equal(error.reason, "timeout");
      assert.match(error.message, /timed out/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 1_000, "rejected at the injected timeout, not the old default");
    const [error] = await fatal;
    assert.equal(error.reason, "timeout");
  } finally {
    await brain.close();
  }
});

test("a slow but streaming turn is not cut off by the stalled-turn timeout", async () => {
  // The fake streams three parts 70 ms apart over 150 ms: longer than the limit in
  // total, but never silent for longer than it.
  const brain = makeBrain({ turnTimeoutMs: 120 });
  try {
    assert.deepEqual(await drain(brain.ask("slow stream")), ["First part.", "Second part.", "Third part."]);
  } finally {
    await brain.close();
  }
});

test("an unspawnable brain rejects with reason unreachable", async () => {
  const brain = makeBrain({ spawnProcess: () => { throw new Error("spawn codex ENOENT"); } });
  try {
    await assert.rejects(drain(brain.ask("Hi")), (error) => {
      assert.equal(error.reason, "unreachable");
      return true;
    });
  } finally {
    await brain.close();
  }
});

test("the Codex brain never inherits Discord or EBI credentials", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { DISCORD_BOT_TOKEN: "discord-secret", JESTER_EBI_API_SECRET: "ebi-secret",
    CCDB_API_SECRET: "relay-secret", JESTER_TEST_KEEP: "kept" });
  let seen = null;
  const brain = makeBrain({ spawnProcess: (command, args, options) => {
    seen = options.env;
    throw new Error("stop after spawn options");
  } });
  try {
    await assert.rejects(brain.prewarm());
    assert.ok(seen, "spawn received an explicit environment");
    assert.equal(seen.JESTER_TEST_KEEP, "kept");
    for (const key of ["DISCORD_BOT_TOKEN", "JESTER_EBI_API_SECRET", "CCDB_API_SECRET"]) {
      assert.equal(seen[key], undefined, `${key} must not reach the model's process`);
    }
  } finally {
    await brain.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("a reply that only mentions a rate or usage limit is an answer, not a limit notice", async () => {
  for (const text of ["You've hit your limit \u00b7 resets 3pm", "5-hour limit reached \u2219 resets 7pm",
    "Claude AI usage limit reached|1759240800", "rate_limit_error"]) {
    assert.equal(isUsageLimitText(text), true, text);
  }
  for (const text of ["Add a rate limit to the login endpoint.", "The usage limit resets at midnight.",
    "If you hit the rate limit, wait a minute.", "Luna is out because the Codex account hit its usage limit.",
    '{"kind":"message","target":"zoro","instruction":"add a rate limit to the API"}']) {
    assert.equal(isUsageLimitText(text), false, text);
  }
  const brain = makeBrain();
  try {
    assert.deepEqual(await drain(brain.ask("limit topic")),
      ["Add a rate limit to the login endpoint.", "The usage limit resets at midnight."]);
    assert.deepEqual(await drain(brain.ask("limit topic", { whole: true })),
      ["Add a rate limit to the login endpoint. The usage limit resets at midnight."]);
  } finally {
    await brain.close();
  }
});

test("injected context keeps only the newest entries while no turn consumes it", () => {
  assert.equal(new Brain().contextLimit, 24);
  const brain = new Brain({ contextLimit: 2 });
  brain.injectContext("one");
  brain.injectContext("two");
  brain.injectContext("three");
  brain.injectContext("   ");
  assert.deepEqual(brain.context, ["two", "three"]);
});

test("createSentenceStream is the one splitter both brains use", () => {
  const stream = createSentenceStream();
  assert.deepEqual(stream.push("Mm-hmm. that works. Sure"), ["That works."]);
  assert.deepEqual(stream.flush(), ["Sure"]);
});

test("the Codex brain names itself codex for the fallback chain", () => {
  assert.equal(new Brain().name, "codex");
});

test("thirty injected lines during an outage keep only the newest 24", () => {
  const brain = new Brain();
  for (let index = 0; index < 30; index += 1) brain.injectContext(`line ${index}`);
  assert.equal(brain.context.length, 24);
  assert.equal(brain.context[0], "line 6");
  assert.equal(brain.context.at(-1), "line 29");
});
