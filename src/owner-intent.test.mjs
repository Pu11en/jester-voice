import assert from "node:assert/strict";
import test from "node:test";
import { parseOwnerIntent, isSessionReadFollowUp } from "./owner-intent.mjs";

test("finds read-only status requests without treating a passing name as an action", () => {
  assert.deepEqual(parseOwnerIntent("Jester, what is Frankie doing?"), { kind: "status-one", target: "Frankie" });
  assert.deepEqual(parseOwnerIntent("Who's running?"), { kind: "status-all" });
  assert.deepEqual(parseOwnerIntent("Jester, update me on my sessions"), { kind: "status-all" });
  assert.equal(parseOwnerIntent("We talked about Frankie yesterday"), null);
  assert.deepEqual(parseOwnerIntent("Jester, stop Zoro"), { kind: "stop", target: "Zoro" });
  assert.deepEqual(parseOwnerIntent("Jester, close Zoro"), { kind: "close", target: "Zoro" });
  assert.deepEqual(parseOwnerIntent("Switch Zoro to Claude Sonnet"),
    { kind: "runtime", target: "Zoro", runtime: "Claude", model: "Sonnet" });
  assert.deepEqual(parseOwnerIntent("Jester, start a new session in jester-voice to check the tests"),
    { kind: "create", project: "jester-voice", runtime: null, model: null,
      instruction: "check the tests" });
  assert.deepEqual(parseOwnerIntent("Start a session in jester-voice with Claude Sonnet to check tests"),
    { kind: "create", project: "jester-voice", runtime: "Claude", model: "Sonnet",
      instruction: "check tests" });
  assert.deepEqual(parseOwnerIntent("Jester, find the session where we worked on login"),
    { kind: "history", query: "login" });
  assert.deepEqual(parseOwnerIntent("When Zoro finishes, tell Sanji to run tests"),
    { kind: "dependency", source: "Zoro", target: "Sanji", instruction: "run tests" });
  assert.deepEqual(parseOwnerIntent("When both finish, tell Frankie to check the links"),
    { kind: "dependency-group", target: "Frankie", instruction: "check the links" });
  assert.deepEqual(parseOwnerIntent("What did it finish?"),
    { kind: "status-last", target: "it" });
  assert.deepEqual(parseOwnerIntent("Jester, what is going on with Zoro?"),
    { kind: "status-one", target: "Zoro" });
  assert.deepEqual(parseOwnerIntent("Jester, what happened with Zoro's audit?",
    { knownTags: new Set(["zoro"]) }), { kind: "session-discuss", target: "zoro" });
  assert.equal(isSessionReadFollowUp("What is this project?"), true);
  assert.equal(isSessionReadFollowUp("What is the weather?"), false);
  assert.deepEqual(parseOwnerIntent("Jester, help me with Zoro's audit"),
    { kind: "session-discuss", target: "Zoro" });
  assert.equal(parseOwnerIntent("Jester, help me with a recipe",
    { knownTags: new Set(["zoro"]) }), null);
  assert.deepEqual(parseOwnerIntent("When both Zoro and Sanji finish, tell me what I can test"),
    { kind: "result-watch", selection: "named", targets: ["Zoro", "Sanji"] });
  assert.deepEqual(parseOwnerIntent("When Zoro, Sanji, and Frankie finish, tell me what I can test"),
    { kind: "result-watch", selection: "named", targets: ["Zoro", "Sanji", "Frankie"] });
  assert.deepEqual(parseOwnerIntent("When all currently running sessions finish, tell me what I can test"),
    { kind: "result-watch", selection: "running", targets: [] });
});

test("final direct address and corrected destination yield one task draft", () => {
  assert.deepEqual(parseOwnerIntent("And Frankie, we need to fix the prompt navigation"),
    { kind: "message", target: "Frankie", instruction: "we need to fix the prompt navigation" });
  assert.deepEqual(parseOwnerIntent("And Frankie? We need to fix the prompt navigation"),
    { kind: "message", target: "Frankie", instruction: "We need to fix the prompt navigation" });
  assert.equal(parseOwnerIntent("How are you?"), null);
  assert.equal(parseOwnerIntent("Can you explain that again?"), null);
  assert.equal(parseOwnerIntent("And then we should test it"), null);
  assert.equal(parseOwnerIntent("Actually, can you explain it again?",
    { knownTags: new Set(["frankie"]) }), null);
  assert.equal(parseOwnerIntent("Frankie, please check it",
    { knownTags: new Set(["frankie"]) }).target, "Frankie");
  assert.deepEqual(parseOwnerIntent("Jester, tell Frankie to add tests"),
    { kind: "message", target: "Frankie", instruction: "add tests" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie we need to fix this"),
    { kind: "message", target: "Frankie", instruction: "we need to fix this" });
  assert.deepEqual(parseOwnerIntent("Frankie—actually Zoro—fix the navigation"),
    { kind: "message", target: "Zoro", instruction: "fix the navigation" });
  assert.deepEqual(parseOwnerIntent("Jester, and Frankie, change the site—wait, Zoro, just review login"),
    { kind: "message", target: "Zoro", instruction: "just review login" });
  assert.deepEqual(parseOwnerIntent("Tell him to add tests"),
    { kind: "message", target: "him", instruction: "add tests" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie"), { kind: "clarify", reason: "missing-task", target: "Frankie" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie to deploy—actually just test"),
    { kind: "message", target: "Frankie", instruction: "just test" });
  assert.deepEqual(parseOwnerIntent("Tell Frankie to work in A—actually in B"),
    { kind: "clarify", reason: "task-correction", target: "Frankie" });
});
