import assert from "node:assert/strict";
import test from "node:test";
import { parseOwnerIntent } from "./owner-intent.mjs";

test("finds read-only status requests without treating a passing name as an action", () => {
  assert.deepEqual(parseOwnerIntent("Jester, what is Frankie doing?"), { kind: "status-one", target: "Frankie" });
  assert.deepEqual(parseOwnerIntent("Who's running?"), { kind: "status-all" });
  assert.equal(parseOwnerIntent("We talked about Frankie yesterday"), null);
});

test("final direct address and corrected destination yield one task draft", () => {
  assert.deepEqual(parseOwnerIntent("And Frankie, we need to fix the prompt navigation"),
    { kind: "message", target: "Frankie", instruction: "we need to fix the prompt navigation" });
  assert.deepEqual(parseOwnerIntent("Jester, tell Frankie to add tests"),
    { kind: "message", target: "Frankie", instruction: "add tests" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie we need to fix this"),
    { kind: "message", target: "Frankie", instruction: "we need to fix this" });
  assert.deepEqual(parseOwnerIntent("Frankie—actually Zoro—fix the navigation"),
    { kind: "message", target: "Zoro", instruction: "fix the navigation" });
  assert.deepEqual(parseOwnerIntent("Tell him to add tests"),
    { kind: "message", target: "him", instruction: "add tests" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie"), { kind: "clarify", reason: "missing-task", target: "Frankie" });
});
