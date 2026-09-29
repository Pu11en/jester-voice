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
  assert.deepEqual(parseOwnerIntent("Jester, open an empty thread in Jobs"),
    { kind: "create", project: "Jobs", runtime: null, model: null,
      instruction: null, empty: true });
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
  assert.equal(isSessionReadFollowUp("Why?"), true);
  assert.equal(isSessionReadFollowUp("What should I do next?"), true);
  assert.equal(isSessionReadFollowUp("Tell me more"), true);
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
  assert.equal(parseOwnerIntent("Tell me more"), null);
  assert.deepEqual(parseOwnerIntent("Tell Zoro to review this, but don't send that yet"),
    { kind: "clarify", reason: "hold" });
});

test("model-free session questions parse without a brain, in Drew's own wording", () => {
  const live = { knownTags: new Set(["zoro", "franky"]) };
  for (const line of [
    "What's open?", "What is open right now?", "What threads do we have open?",
    "What sessions are open?", "Like what sessions that are actually open?",
    "List my sessions", "List my threads", "Which threads are open?",
    "Jester, what sessions do I have open?", "Are there any sessions open?",
  ]) assert.deepEqual(parseOwnerIntent(line, live), { kind: "list-open" }, line);
  assert.deepEqual(parseOwnerIntent("Jester, do you see pod locks?", live), { kind: "see-one", target: "pod locks" });
  assert.deepEqual(parseOwnerIntent("Yo, Jester, do you see pod logs?", live), { kind: "see-one", target: "pod logs" });
  assert.deepEqual(parseOwnerIntent("Is podlox open?", live), { kind: "see-one", target: "podlox" });
  assert.deepEqual(parseOwnerIntent("Do you have Zoro?", live), { kind: "see-one", target: "Zoro" });
  assert.deepEqual(parseOwnerIntent("Can you see the Task loop thread?", live), { kind: "see-one", target: "Task loop" });
  assert.deepEqual(parseOwnerIntent("Is it open?", live), { kind: "see-one", target: "it" });
  assert.equal(parseOwnerIntent("Do you see what I mean?", live), null);
  assert.equal(parseOwnerIntent("Do you see the problem with this approach?", live), null);
  assert.deepEqual(parseOwnerIntent(
    "Yeah, so I need you to, you know, how come there's nothing, like no tag on one of the sessions?", live),
  { kind: "why-no-tag", target: null });
  assert.deepEqual(parseOwnerIntent("Why is there no tag on the thread I created?", live), { kind: "why-no-tag", target: null });
  assert.deepEqual(parseOwnerIntent("Jester, why no tag?", live), { kind: "why-no-tag", target: null });
  assert.deepEqual(parseOwnerIntent("Why does podlox have no tag?", live), { kind: "why-no-tag", target: "podlox" });
  assert.deepEqual(parseOwnerIntent("How come there's no tag on the podlox session?", live), { kind: "why-no-tag", target: "podlox" });
  const addressed = parseOwnerIntent("Tell Frankie there's no tag on the release", live);
  assert.notEqual(addressed.kind, "why-no-tag", "a turn addressed to a session is never a tag question");
  assert.equal(addressed.target, "Frankie");
  assert.deepEqual(parseOwnerIntent("Find podlox", live), { kind: "history", query: "podlox" });
  assert.deepEqual(parseOwnerIntent("Jester, search for pod locks", live), { kind: "history", query: "pod locks" });
  assert.deepEqual(parseOwnerIntent("Look up the Task loop thread", live), { kind: "history", query: "Task loop" });
  assert.deepEqual(parseOwnerIntent("Find the session where we worked on login", live), { kind: "history", query: "login" });
  assert.equal(parseOwnerIntent("Find out what Zoro did", live), null);
  assert.deepEqual(parseOwnerIntent("Jester, stop Zoro", live), { kind: "stop", target: "Zoro" });
  assert.deepEqual(parseOwnerIntent("Jester, open an empty thread in Jobs", live),
    { kind: "create", project: "Jobs", runtime: null, model: null, instruction: null, empty: true });
  assert.deepEqual(parseOwnerIntent("Who's running?", live), { kind: "status-all" });
});

test("an action whose task words mention tags or sessions is never hijacked by a question", () => {
  const live = { knownTags: new Set(["zoro", "nami"]) };
  assert.deepEqual(parseOwnerIntent("Create a session in jobs to find out why podlox has no tag", live),
    { kind: "create", project: "jobs", runtime: null, model: null, instruction: "find out why podlox has no tag" });
  assert.deepEqual(parseOwnerIntent("Open a session in jobs and tell it to explain why there's no tag on it", live),
    { kind: "create", project: "jobs", runtime: null, model: null, instruction: "explain why there's no tag on it" });
  assert.deepEqual(parseOwnerIntent("When Zoro finishes, tell Nami to check why there is no tag", live),
    { kind: "dependency", source: "Zoro", target: "Nami", instruction: "check why there is no tag" });
  assert.deepEqual(parseOwnerIntent("Find the session where we talked about why there was no tag", live),
    { kind: "history", query: "why there was no tag" });
  // "Can you have X do Y" asks Jester to get work done; it is not a do-you-see question.
  assert.equal(parseOwnerIntent("Could you have Zoro run the tests?", live), null);
  assert.equal(parseOwnerIntent("Can you have Nami check the build?", live), null);
  assert.deepEqual(parseOwnerIntent("Do you have podlox open?", live), { kind: "see-one", target: "podlox" });
  assert.deepEqual(parseOwnerIntent("How come there's no tag on podlox?", live), { kind: "why-no-tag", target: "podlox" });
});
