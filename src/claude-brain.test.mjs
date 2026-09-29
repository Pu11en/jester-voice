import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JESTER_INSTRUCTIONS, createSentenceStream as sharedSentenceStream } from "./brain.mjs";
import { CLAUDE_FAST_ENV, ClaudeBrain, DEFAULT_CLAUDE_MODEL, createSentenceStream } from "./claude-brain.mjs";

const fakeCli = fileURLToPath(new URL("./fake-claude-cli.mjs", import.meta.url));
const makeBrain = (options = {}) => new ClaudeBrain({
  command: fakeCli,
  turnTimeoutMs: 2_000,
  interruptTimeoutMs: 2_000,
  ...options,
});
const drain = async (iterable) => {
  const sentences = [];
  for await (const sentence of iterable) sentences.push(sentence);
  return sentences;
};

test("prewarms one CLI process and yields streamed sentences with a firstWord event", async () => {
  const brain = makeBrain();
  try {
    await brain.prewarm();
    const child = brain.child;
    assert.ok(child, "prewarm spawned the CLI");
    await brain.prewarm();
    assert.equal(brain.child, child, "a second prewarm reuses the running CLI");
    const firstWords = [];
    brain.on("firstWord", (event) => firstWords.push(event));
    const sentences = await drain(brain.ask("Hi", { speaker: "owner", requestId: "voice-turn-1" }));
    assert.deepEqual(sentences, ["Hello there.", "How can I help?"]);
    assert.equal(firstWords.length, 1);
    assert.equal(firstWords[0].requestId, "voice-turn-1");
    assert.equal(firstWords[0].speaker, "owner");
    assert.equal(brain.child, child, "the CLI stays up between turns");
  } finally {
    await brain.close();
  }
});

test("injectContext is sent with the next ask without starting an extra turn", async () => {
  const brain = makeBrain();
  try {
    await brain.prewarm();
    brain.injectContext("Jester said: heard before");
    assert.deepEqual(await drain(brain.ask("What did you say?")), ["Context kept."]);
    assert.deepEqual(await drain(brain.ask("And now?")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("injected context is bounded to the newest entries", () => {
  const brain = makeBrain({ contextLimit: 2 });
  brain.injectContext("one");
  brain.injectContext("two");
  brain.injectContext("three");
  brain.injectContext("   ");
  assert.deepEqual(brain.context, ["two", "three"]);
});

test("a result with is_error rejects with reason failed and the brain stays usable", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("failed turn")), (error) => {
      assert.equal(error.reason, "failed");
      assert.match(error.message, /Something broke/);
      return true;
    });
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("a usage-limit result rejects with reason usageLimitExceeded and nothing is spoken", async () => {
  const brain = makeBrain();
  try {
    const spoken = [];
    await assert.rejects((async () => {
      for await (const sentence of brain.ask("usage limit")) spoken.push(sentence);
    })(), (error) => {
      assert.equal(error.reason, "usageLimitExceeded");
      assert.match(error.message, /usage limit/i);
      return true;
    });
    assert.deepEqual(spoken, []);
  } finally {
    await brain.close();
  }
});

test("an API 429 result rejects with reason usageLimitExceeded even without limit words", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("api limit")), (error) => {
      assert.equal(error.reason, "usageLimitExceeded");
      assert.match(error.message, /429/);
      return true;
    });
    assert.equal(brain.rateLimit?.status, "rejected", "the last rate_limit_event is kept for diagnostics");
  } finally {
    await brain.close();
  }
});

test("an API 5xx result rejects with reason unreachable", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("server error")), (error) => {
      assert.equal(error.reason, "unreachable");
      assert.match(error.message, /529/);
      return true;
    });
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("an authentication failure rejects with reason authFailed", async () => {
  const brain = makeBrain();
  try {
    await assert.rejects(drain(brain.ask("auth failure")), (error) => {
      assert.equal(error.reason, "authFailed");
      return true;
    });
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

test("interrupt stops yielding, drops the unfinished sentence and keeps the CLI for the next turn", async () => {
  const brain = makeBrain();
  try {
    await brain.prewarm();
    const child = brain.child;
    const iterator = brain.ask("long reply")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: "Starting now.", done: false });
    assert.equal(await brain.interrupt(), true);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.equal(await brain.interrupt(), false);
    assert.equal(brain.child, child, "an honoured interrupt keeps the CLI process");
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("an ignored interrupt kills the CLI and the next turn respawns it", async () => {
  const brain = makeBrain({ interruptTimeoutMs: 50, restartBaseMs: 1, restartMaxMs: 2 });
  try {
    await brain.prewarm();
    const child = brain.child;
    const iterator = brain.ask("ignores interrupt")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: "Starting now.", done: false });
    assert.equal(await brain.interrupt(), true);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.equal(brain.child, null, "the stuck CLI was dropped");
    await once(child, "exit");
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
    assert.notEqual(brain.child, child, "the next turn runs on a fresh CLI");
  } finally {
    await brain.close();
  }
});

test("abandoning a reply mid-stream interrupts the CLI so the next ask starts cleanly", async () => {
  const brain = makeBrain();
  try {
    for await (const sentence of brain.ask("long reply")) {
      assert.equal(sentence, "Starting now.");
      break;
    }
    assert.deepEqual(await drain(brain.ask("Hi")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("close kills the CLI process", async () => {
  const brain = makeBrain();
  await brain.prewarm();
  const child = brain.child;
  const exited = once(child, "exit");
  await brain.close();
  await exited;
  assert.equal(brain.child, null);
  await assert.rejects(brain.prewarm(), (error) => {
    assert.equal(error.reason, "closed");
    return true;
  });
});

test("a hung turn rejects with reason timeout, kills the CLI and the next turn starts cleanly", async () => {
  const brain = makeBrain({ turnTimeoutMs: 30, restartBaseMs: 1, restartMaxMs: 2 });
  try {
    const fatal = once(brain, "fatal");
    await assert.rejects(drain(brain.ask("hang forever")), (error) => {
      assert.equal(error.reason, "timeout");
      return true;
    });
    const [error] = await fatal;
    assert.equal(error.reason, "timeout");
    assert.equal(brain.child, null);
    brain.turnTimeoutMs = 2_000; // the respawned CLI may take longer than 30 ms to boot under load
    assert.deepEqual(await drain(brain.ask("next turn")), ["Hello there.", "How can I help?"]);
  } finally {
    await brain.close();
  }
});

test("a slow but streaming turn is not cut off by the stalled-turn timeout", async () => {
  const brain = makeBrain({ turnTimeoutMs: 120 });
  try {
    assert.deepEqual(await drain(brain.ask("slow stream")), ["First part.", "Second part.", "Third part."]);
  } finally {
    await brain.close();
  }
});

test("the CLI exiting mid-turn rejects with reason unreachable", async () => {
  const brain = makeBrain({ restartBaseMs: 1, restartMaxMs: 2 });
  try {
    await assert.rejects(drain(brain.ask("exit now")), (error) => {
      assert.equal(error.reason, "unreachable");
      return true;
    });
    assert.equal(brain.child, null);
  } finally {
    await brain.close();
  }
});

test("an unspawnable CLI rejects with reason unreachable", async () => {
  const brain = makeBrain({ spawnProcess: () => { throw new Error("spawn claude ENOENT"); } });
  try {
    await assert.rejects(drain(brain.ask("Hi")), (error) => {
      assert.equal(error.reason, "unreachable");
      return true;
    });
  } finally {
    await brain.close();
  }
});

test("emits thinking after the configured stall interval", async () => {
  const brain = makeBrain({ stallMs: 15 });
  try {
    const thinking = once(brain, "thinking");
    const response = drain(brain.ask("delayed reply", { speaker: "owner" }));
    const [event] = await thinking;
    assert.equal(event.speaker, "owner");
    assert.deepEqual(await response, ["A little later."]);
  } finally {
    await brain.close();
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

test("a second ask while a turn is running rejects with reason busy", async () => {
  const brain = makeBrain();
  try {
    const iterator = brain.ask("long reply")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: "Starting now.", done: false });
    await assert.rejects(drain(brain.ask("Hi")), (error) => {
      assert.equal(error.reason, "busy");
      return true;
    });
    await brain.interrupt();
    await iterator.return();
  } finally {
    await brain.close();
  }
});

test("the CLI is spawned argv-only in print mode and the prompt travels only through stdin", async () => {
  const seen = {};
  const written = [];
  const brain = makeBrain({
    model: "claude-test-model",
    spawnProcess: (command, args, options) => {
      Object.assign(seen, { command, args, options });
      const child = spawn(command, args, options);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        written.push(String(chunk));
        return write(chunk, ...rest);
      };
      return child;
    },
  });
  try {
    const prompt = "secret phrase; rm -rf / && echo $HOME";
    assert.deepEqual(await drain(brain.ask(prompt, { speaker: "owner" })), ["Hello there.", "How can I help?"]);
    assert.equal(seen.command, fakeCli);
    assert.ok(!seen.options.shell, "spawned without a shell");
    assert.equal(seen.options.cwd, "/tmp");
    const args = seen.args;
    assert.equal(args[0], "-p");
    for (const pair of [["--input-format", "stream-json"], ["--output-format", "stream-json"],
      ["--model", "claude-test-model"], ["--system-prompt", JESTER_INSTRUCTIONS], ["--tools", ""]]) {
      const index = args.indexOf(pair[0]);
      assert.notEqual(index, -1, `${pair[0]} is passed`);
      assert.equal(args[index + 1], pair[1], `${pair[0]} value`);
    }
    for (const flag of ["--include-partial-messages", "--verbose", "--no-session-persistence"]) {
      assert.ok(args.includes(flag), `${flag} is passed`);
    }
    assert.ok(!args.includes("--max-turns"), "no flag this CLI version does not know");
    assert.ok(args.every((arg) => !arg.includes("secret phrase")), "the prompt is not on the command line");
    const messages = written.map((line) => JSON.parse(line));
    assert.equal(messages.length, 1, "one JSON line per turn");
    assert.equal(messages[0].type, "user");
    assert.equal(messages[0].message.role, "user");
    const text = messages[0].message.content.map((block) => block.text).join("\n");
    assert.ok(text.includes(prompt), "the prompt is inside the stdin JSON line");
    assert.ok(text.startsWith("[owner]: "), "the speaker prefix is kept");
  } finally {
    await brain.close();
  }
});

test("the default model is Haiku 4.5 and the model is an option", () => {
  assert.equal(DEFAULT_CLAUDE_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(new ClaudeBrain().model, DEFAULT_CLAUDE_MODEL);
  assert.equal(new ClaudeBrain({ model: "claude-sonnet-4-5" }).model, "claude-sonnet-4-5");
  assert.equal(new ClaudeBrain().name, "claude");
});

test("the Claude brain never inherits Discord or EBI credentials", async () => {
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

test("createSentenceStream splits deltas into spoken sentences like the Codex brain", () => {
  const stream = createSentenceStream();
  assert.deepEqual(stream.push("Hello there. How "), ["Hello there."]);
  assert.deepEqual(stream.push("can I help?"), []);
  assert.deepEqual(stream.flush(), ["How can I help?"]);
  assert.deepEqual(stream.flush(), []);

  const filler = createSentenceStream();
  assert.deepEqual(filler.push("Mm-hmm. "), []);
  assert.deepEqual(filler.push("that works. Sure."), ["That works."]);
  assert.deepEqual(filler.flush(), ["Sure."]);

  const whole = createSentenceStream({ whole: true });
  assert.deepEqual(whole.push("One. Two. "), []);
  assert.deepEqual(whole.flush(), ["One. Two."]);

  const quiet = createSentenceStream();
  assert.deepEqual(quiet.push("Uh-huh."), []);
  assert.deepEqual(quiet.flush(), []);
});

test("the Claude brain uses the Codex brain's sentence splitter, not a copy", () => {
  assert.equal(createSentenceStream, sharedSentenceStream);
});

test("the Claude CLI runs on the stored plan login, never a paid API key or another endpoint", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: "paid-key", ANTHROPIC_AUTH_TOKEN: "other-token",
    ANTHROPIC_BASE_URL: "https://example.invalid", HOME: saved.HOME || "/home/test" });
  let seen = null;
  const brain = makeBrain({ spawnProcess: (command, args, options) => {
    seen = options.env;
    throw new Error("stop after spawn options");
  } });
  try {
    await assert.rejects(brain.prewarm());
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      assert.equal(seen[key], undefined, `${key} must not reach the Claude CLI`);
    }
    assert.equal(seen.HOME, process.env.HOME, "HOME stays so the CLI finds its stored login");
  } finally {
    await brain.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("the CLI runs with extended thinking off so the first sentence is not delayed", async () => {
  const seen = {};
  const brain = makeBrain({
    spawnProcess: (command, args, options) => {
      Object.assign(seen, { args, env: options.env });
      return spawn(command, args, options);
    },
  });
  try {
    assert.deepEqual(await drain(brain.ask("hello", { speaker: "owner" })), ["Hello there.", "How can I help?"]);
    assert.equal(seen.env.MAX_THINKING_TOKENS, "0");
    assert.equal(CLAUDE_FAST_ENV.MAX_THINKING_TOKENS, "0");
    assert.ok(seen.env.HOME, "HOME reaches the CLI so it finds its login");
    assert.ok(!seen.args.includes("hello"), "the prompt stays off the command line");
  } finally {
    await brain.close();
  }
});
