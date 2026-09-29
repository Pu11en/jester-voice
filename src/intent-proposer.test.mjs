import assert from "node:assert/strict";
import test from "node:test";
import { IntentProposer } from "./intent-proposer.mjs";
import { FallbackBrain } from "./brain-fallback.mjs";

const rawProposer = (text) => new IntentProposer({ brain: {
  async *ask() { yield text; }, async close() {}, async interrupt() {},
} });
const proposer = (reply) => rawProposer(JSON.stringify(reply));

test("natural assignment becomes a typed proposal with exact owner words", async () => {
  const raw = "Jester, could you put this in Zoro's thread: review the login page and don't edit files";
  const intent = await proposer({ kind: "message", target: "Zoro",
    instruction: "review the login page and don't edit files" }).propose(raw, ["zoro"]);
  assert.deepEqual(intent, { kind: "message", target: "zoro",
    instruction: "review the login page and don't edit files" });
});

test("discussion, invented task text, and unknown targets cannot become writes", async () => {
  const model = proposer({ kind: "message", target: "Zoro", instruction: "deploy production" });
  assert.equal(await model.propose("Jester, what should Zoro do?", ["zoro"]), null);
  assert.equal((await model.propose("Jester, could you ask Zoro to review login?", ["zoro"])).kind,
    "clarify");
  assert.equal((await proposer({ kind: "message", target: "Nami", instruction: "review login" })
    .propose("Jester, could you ask Zoro to review login?", ["zoro"])).kind, "clarify");
  assert.equal((await proposer({ kind: "message", target: "Zoro", instruction: "review login" })
    .propose("Jester, could you ask Zoro to review login and do not edit files?", ["zoro"])).kind,
    "clarify");
  assert.equal((await model.propose("Jester, could you ask Zoro to review login, but don't send it yet", ["zoro"])).reason,
    "hold");
});

test("a proposed instruction must be whole owner words, not a word fragment", async () => {
  const raw = "Jester, could you ask Zoro to restart the server";
  for (const instruction of ["art the server", "tart the server", ".", "?"]) {
    const intent = await proposer({ kind: "message", target: "Zoro", instruction }).propose(raw, ["zoro"]);
    assert.equal(intent?.kind, "clarify", `${JSON.stringify(instruction)} must not be sent`);
  }
  const whole = await proposer({ kind: "message", target: "Zoro", instruction: "restart the server" })
    .propose(raw, ["zoro"]);
  assert.deepEqual(whole, { kind: "message", target: "zoro", instruction: "restart the server" });
});

test("a fenced or briefly wrapped JSON reply parses into the same proposal as a bare one", async () => {
  const raw = "Jester, could you ask Zoro to restart the server";
  const reply = { kind: "message", target: "Zoro", instruction: "restart the server" };
  const bare = await proposer(reply).propose(raw, ["zoro"]);
  assert.deepEqual(bare, { kind: "message", target: "zoro", instruction: "restart the server" });
  const json = JSON.stringify(reply);
  for (const text of ["```json\n" + json + "\n```", "```\n" + json + "\n```",
    "Here is the proposal: " + json + " Done.", "  " + JSON.stringify(reply, null, 2) + "\n"]) {
    assert.deepEqual(await rawProposer(text).propose(raw, ["zoro"]), bare, text);
  }
  const braces = { kind: "message", target: "Zoro", instruction: "restart the server {now}" };
  assert.deepEqual(await rawProposer("```json\n" + JSON.stringify(braces) + "\n```")
    .propose("Jester, could you ask Zoro to restart the server {now}", ["zoro"]),
  { kind: "message", target: "zoro", instruction: "restart the server {now}" });
});

test("a wrapped reply is validated as strictly as a bare one", async () => {
  const raw = "Jester, could you ask Zoro to restart the server";
  for (const text of [
    "```json\n" + JSON.stringify({ kind: "message", target: "Zoro", instruction: "deploy production" }) + "\n```",
    "Sure: " + JSON.stringify({ kind: "message", target: "Nami", instruction: "restart the server" }),
    "```json\n" + JSON.stringify({ kind: "delete", target: "Zoro", instruction: "restart the server" }) + "\n```",
    "```json\n{\"kind\": \"message\", \"target\": \"Zoro\"\n```",
    "I cannot classify that.",
  ]) {
    assert.equal((await rawProposer(text).propose(raw, ["zoro"]))?.kind, "clarify", text);
  }
  assert.equal(await rawProposer("```json\n{\"kind\":\"none\"}\n```").propose(raw, ["zoro"]), null);
});

function fakeBrain(name, ask) {
  return { name, on() {}, async *ask(...args) { yield* ask(...args); },
    async close() {}, async interrupt() { return false; }, async prewarm() {} };
}

test("while Codex is out of quota the Claude backup answers the proposal", async () => {
  const raw = "Jester, could you ask Zoro to restart the server";
  const brain = new FallbackBrain({
    primary: fakeBrain("codex", async function* () {
      throw Object.assign(new Error("usage limit"), { reason: "usageLimitExceeded" });
    }),
    secondary: fakeBrain("claude", async function* () {
      yield "```json\n" + JSON.stringify({ kind: "message", target: "Zoro",
        instruction: "restart the server" }) + "\n```";
    }),
    logger: {},
  });
  assert.deepEqual(await new IntentProposer({ brain }).propose(raw, ["zoro"]),
    { kind: "message", target: "zoro", instruction: "restart the server" });
});

test("when both brains fail the proposal is honestly unavailable", async () => {
  const raw = "Jester, could you ask Zoro to restart the server";
  const out = (reason) => async function* () { throw Object.assign(new Error(reason), { reason }); };
  const brain = new FallbackBrain({ primary: fakeBrain("codex", out("usageLimitExceeded")),
    secondary: fakeBrain("claude", out("unreachable")), logger: {} });
  assert.deepEqual(await new IntentProposer({ brain }).propose(raw, ["zoro"]),
    { kind: "clarify", reason: "proposal-unavailable" });
});
