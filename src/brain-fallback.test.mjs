import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { brainError } from "./brain.mjs";
import { FallbackBrain, SWITCH_REASONS } from "./brain-fallback.mjs";

/** An in-memory brain whose ask() runs the next scripted responder for each call. */
function fakeBrain(name, ...script) {
  const brain = new EventEmitter();
  Object.assign(brain, { name, calls: [], prewarms: 0, prewarmError: null, interrupts: 0,
    contexts: [], closed: false, script });
  brain.prewarm = async () => {
    brain.prewarms += 1;
    if (brain.prewarmError) throw brain.prewarmError;
    return name;
  };
  brain.ask = async function* (text, options = {}) {
    brain.calls.push({ text, options });
    const responder = brain.script.length > 1 ? brain.script.shift() : brain.script[0];
    if (!responder) throw new Error(`${name} has no scripted reply`);
    yield* responder(text, options);
  };
  brain.interrupt = async () => {
    brain.interrupts += 1;
    return true;
  };
  brain.injectContext = (text) => brain.contexts.push(text);
  brain.close = async () => { brain.closed = true; };
  return brain;
}

const answers = (...sentences) => async function* () { yield* sentences; };
const fails = (reason, message = `${reason} from the fake`) => async function* () {
  throw brainError(message, reason);
};
const failsAfter = (sentence, reason) => async function* () {
  yield sentence;
  throw brainError(`${reason} after speaking`, reason);
};
const drain = async (iterable) => {
  const sentences = [];
  for await (const sentence of iterable) sentences.push(sentence);
  return sentences;
};
const quiet = { warn() {}, info() {} };

function makeFallback({ primary, secondary, retryAfterMs = 1_000, now = { value: 0 } } = {}) {
  const brain = new FallbackBrain({ primary, secondary, retryAfterMs, clock: () => now.value, logger: quiet });
  const switches = [];
  brain.on("brainSwitched", (event) => switches.push(event));
  return { brain, switches, now };
}

test("the primary answers and the secondary is never asked", async () => {
  const primary = fakeBrain("codex", answers("Hello there.", "How can I help?"));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches } = makeFallback({ primary, secondary });
  assert.deepEqual(await drain(brain.ask("Hi", { speaker: "owner" })), ["Hello there.", "How can I help?"]);
  assert.equal(primary.calls.length, 1);
  assert.deepEqual(primary.calls[0].options, { speaker: "owner" });
  assert.deepEqual(secondary.calls, []);
  assert.deepEqual(switches, []);
});

test("a usage-limited primary hands the same ask to the secondary and emits brainSwitched", async () => {
  const primary = fakeBrain("codex", fails("usageLimitExceeded", "You've hit your usage limit."));
  const secondary = fakeBrain("claude", answers("Claude here.", "What do you need?"));
  const { brain, switches } = makeFallback({ primary, secondary });
  assert.deepEqual(await drain(brain.ask("Hi", { requestId: "voice-turn-1" })),
    ["Claude here.", "What do you need?"]);
  assert.equal(primary.calls.length, 1);
  assert.equal(secondary.calls.length, 1);
  assert.deepEqual(secondary.calls[0], { text: "Hi", options: { requestId: "voice-turn-1" } });
  assert.deepEqual(switches, [{ from: "codex", to: "claude", reason: "usageLimitExceeded" }]);
  assert.equal(brain.active, "claude");

  assert.deepEqual(await drain(brain.ask("Again")), ["Claude here.", "What do you need?"]);
  assert.equal(primary.calls.length, 1, "the primary is not retried before retryAfterMs");
  assert.equal(secondary.calls.length, 2);
});

test("the primary is retried after retryAfterMs and a good answer switches back", async () => {
  const primary = fakeBrain("codex", fails("usageLimitExceeded"), answers("Codex is back."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches, now } = makeFallback({ primary, secondary, retryAfterMs: 1_000 });
  assert.deepEqual(await drain(brain.ask("One")), ["Claude here."]);
  now.value = 999;
  assert.deepEqual(await drain(brain.ask("Two")), ["Claude here."]);
  assert.equal(primary.calls.length, 1, "no retry before the interval elapses");
  now.value = 1_000;
  assert.deepEqual(await drain(brain.ask("Three")), ["Codex is back."]);
  assert.equal(primary.calls.length, 2);
  assert.equal(secondary.calls.length, 2);
  assert.equal(brain.active, "codex");
  assert.deepEqual(switches, [
    { from: "codex", to: "claude", reason: "usageLimitExceeded" },
    { from: "claude", to: "codex", reason: "recovered" },
  ]);
});

test("a failed retry answers from the secondary and postpones the next retry", async () => {
  const primary = fakeBrain("codex", fails("usageLimitExceeded"), fails("usageLimitExceeded"),
    answers("Codex is back."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches, now } = makeFallback({ primary, secondary, retryAfterMs: 1_000 });
  assert.deepEqual(await drain(brain.ask("One")), ["Claude here."]);
  now.value = 1_000;
  assert.deepEqual(await drain(brain.ask("Two")), ["Claude here."]);
  assert.equal(primary.calls.length, 2, "retried once the interval elapsed");
  now.value = 1_500;
  assert.deepEqual(await drain(brain.ask("Three")), ["Claude here."]);
  assert.equal(primary.calls.length, 2, "the failed retry pushed the next retry out");
  now.value = 2_000;
  assert.deepEqual(await drain(brain.ask("Four")), ["Codex is back."]);
  assert.equal(primary.calls.length, 3);
  assert.equal(switches.length, 3);
  assert.deepEqual(switches.at(-1), { from: "claude", to: "codex", reason: "recovered" });
});

test("a secondary failure rejects with its reason and names the brain", async () => {
  const primary = fakeBrain("codex", fails("unreachable", "Codex app-server exited (1)"));
  const secondary = fakeBrain("claude", fails("failed", "Claude CLI turn error_during_execution"));
  const { brain } = makeFallback({ primary, secondary });
  await assert.rejects(drain(brain.ask("Hi")), (error) => {
    assert.equal(error.reason, "failed");
    assert.equal(error.brain, "claude");
    assert.match(error.message, /Claude CLI/);
    return true;
  });
  assert.equal(brain.active, "claude");
});

test("a primary failure after the first word is not re-asked but marks the primary out", async () => {
  const primary = fakeBrain("codex", failsAfter("First part.", "usageLimitExceeded"));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches } = makeFallback({ primary, secondary });
  const spoken = [];
  await assert.rejects((async () => {
    for await (const sentence of brain.ask("Hi")) spoken.push(sentence);
  })(), (error) => {
    assert.equal(error.reason, "usageLimitExceeded");
    assert.equal(error.brain, "codex");
    return true;
  });
  assert.deepEqual(spoken, ["First part."]);
  assert.deepEqual(secondary.calls, [], "a half-spoken reply is never re-asked");
  assert.deepEqual(switches, [{ from: "codex", to: "claude", reason: "usageLimitExceeded" }]);
  assert.deepEqual(await drain(brain.ask("Next")), ["Claude here."]);
  assert.equal(primary.calls.length, 1);
});

test("a primary failure with an unrelated reason is reported, not switched", async () => {
  const primary = fakeBrain("codex", fails("contextWindowExceeded"), answers("Still Codex."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches } = makeFallback({ primary, secondary });
  await assert.rejects(drain(brain.ask("Hi")), (error) => {
    assert.equal(error.reason, "contextWindowExceeded");
    assert.equal(error.brain, "codex");
    return true;
  });
  assert.deepEqual(secondary.calls, []);
  assert.deepEqual(switches, []);
  assert.deepEqual(await drain(brain.ask("Again")), ["Still Codex."]);
});

test("unreachable and timeout failures before the first word also switch", async () => {
  assert.deepEqual([...SWITCH_REASONS].sort(), ["httpConnectionFailed", "internalServerError",
    "rateLimitExceeded", "responseStreamConnectionFailed", "responseStreamDisconnected",
    "responseTooManyFailedAttempts", "sessionBudgetExceeded", "timeout", "unreachable", "usageLimitExceeded"]);
  for (const reason of SWITCH_REASONS) {
    const primary = fakeBrain("codex", fails(reason));
    const secondary = fakeBrain("claude", answers("Claude here."));
    const { brain, switches } = makeFallback({ primary, secondary });
    assert.deepEqual(await drain(brain.ask("Hi")), ["Claude here."], reason);
    assert.deepEqual(switches, [{ from: "codex", to: "claude", reason }]);
  }
});

test("interrupt, injectContext and close fan out to both brains", async () => {
  const primary = fakeBrain("codex", answers("Hello."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain } = makeFallback({ primary, secondary });
  assert.equal(await brain.interrupt(), true);
  brain.injectContext("Jester said (heard): hello");
  await brain.close();
  assert.equal(primary.interrupts, 1);
  assert.equal(secondary.interrupts, 1);
  assert.deepEqual(primary.contexts, ["Jester said (heard): hello"]);
  assert.deepEqual(secondary.contexts, ["Jester said (heard): hello"]);
  assert.equal(primary.closed, true);
  assert.equal(secondary.closed, true);
});

test("interrupt reports true when either brain had a turn to stop", async () => {
  const primary = fakeBrain("codex", answers("Hello."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  primary.interrupt = async () => false;
  const { brain } = makeFallback({ primary, secondary });
  assert.equal(await brain.interrupt(), true);
  secondary.interrupt = async () => false;
  assert.equal(await brain.interrupt(), false);
});

test("prewarm targets the active brain and switches when the primary is unreachable", async () => {
  const primary = fakeBrain("codex", answers("Hello."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain, switches } = makeFallback({ primary, secondary });
  await brain.prewarm();
  assert.equal(primary.prewarms, 1);
  assert.equal(secondary.prewarms, 0);

  primary.prewarmError = brainError("spawn codex ENOENT", "unreachable");
  const second = fakeBrain("claude", answers("Claude here."));
  const other = makeFallback({ primary, secondary: second });
  await other.brain.prewarm();
  assert.equal(second.prewarms, 1);
  assert.deepEqual(other.switches, [{ from: "codex", to: "claude", reason: "unreachable" }]);
  assert.deepEqual(await drain(other.brain.ask("Hi")), ["Claude here."]);
  assert.equal(primary.calls.length, 0, "an unreachable primary is not asked until the retry");
  assert.deepEqual(switches, []);
});

test("brain events are forwarded from both brains", () => {
  const primary = fakeBrain("codex", answers("Hello."));
  const secondary = fakeBrain("claude", answers("Claude here."));
  const { brain } = makeFallback({ primary, secondary });
  const seen = [];
  for (const name of ["firstWord", "thinking", "notification"]) {
    brain.on(name, (payload) => seen.push([name, payload]));
  }
  primary.emit("firstWord", { requestId: "voice-turn-1" });
  secondary.emit("thinking", { speaker: "owner" });
  primary.emit("notification", { method: "x" });
  assert.deepEqual(seen.map(([name]) => name), ["firstWord", "thinking", "notification"]);
  assert.equal(seen[0][1].requestId, "voice-turn-1");
});

test("only the brain answering the current turn can fail it, and never with a failure the chain recovers from", async () => {
  const fatal = (brain, reason) => brain.emit("fatal", brainError(`${brain.name} ${reason}`, reason));
  const primary = fakeBrain("codex",
    async function* () { fatal(primary, "timeout"); throw brainError("Codex app-server turn timed out", "timeout"); },
    async function* () { fatal(primary, "failed"); throw brainError("Codex app-server failed", "failed"); });
  const secondary = fakeBrain("claude", async function* () {
    fatal(primary, "unreachable"); // the idle primary dying does not concern this turn
    yield "Claude here.";
  }, async function* () {
    fatal(secondary, "unreachable");
    throw brainError("Claude CLI exited (1)", "unreachable");
  });
  const { brain, now } = makeFallback({ primary, secondary, retryAfterMs: 1_000 });
  const seen = [];
  brain.on("fatal", (error) => seen.push([error.brain, error.reason]));
  fatal(primary, "unreachable");
  fatal(secondary, "unreachable");
  assert.deepEqual(seen, [], "an idle brain failing is not a failed turn");
  assert.deepEqual(await drain(brain.ask("One")), ["Claude here."], "the chain recovers from a timed-out primary");
  assert.deepEqual(seen, []);
  await assert.rejects(drain(brain.ask("Two")), (error) => error.reason === "unreachable" && error.brain === "claude");
  assert.deepEqual(seen, [["claude", "unreachable"]]);
  now.value = 1_000;
  await assert.rejects(drain(brain.ask("Three")), (error) => error.reason === "failed" && error.brain === "codex");
  assert.deepEqual(seen, [["claude", "unreachable"], ["codex", "failed"]]);
});

test("constructor requires both brains and defaults the retry interval to ten minutes", () => {
  assert.throws(() => new FallbackBrain({ primary: fakeBrain("codex") }), /secondary/);
  const brain = new FallbackBrain({ primary: fakeBrain("codex"), secondary: fakeBrain("claude") });
  assert.equal(brain.retryAfterMs, 600_000);
  assert.equal(brain.active, "codex");
  const unnamed = new FallbackBrain({ primary: new EventEmitter(), secondary: new EventEmitter() });
  assert.equal(unnamed.active, "primary");
});
