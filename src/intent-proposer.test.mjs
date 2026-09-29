import assert from "node:assert/strict";
import test from "node:test";
import { IntentProposer } from "./intent-proposer.mjs";

const proposer = (reply) => new IntentProposer({ brain: {
  async *ask() { yield JSON.stringify(reply); }, async close() {}, async interrupt() {},
} });

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
