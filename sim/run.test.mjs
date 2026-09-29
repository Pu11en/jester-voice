import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Presence } from "../src/presence.mjs";
import { grade, runAll } from "./run.mjs";

test("simulation flags an extra action, wrong destination, and unsupported spoken claim", () => {
  const actual = { speech: ["I posted it to Zoro."], writes: [
    { kind: "spoken", target: "franky", threadId: "1553899450227757156", text: "deploy" },
  ], brain: [], watches: [], groups: [], muted: false, disconnected: false };
  const failures = grade({ silence: true, writes: 0, writeThreadId: "1553779983158349925" }, actual);
  assert.ok(failures.some(reason => reason.startsWith("Spoke:")));
  assert.ok(failures.some(reason => reason.includes("EBI writes")));
  assert.ok(failures.some(reason => reason.includes("thread ID")));
});

test("simulation isolates presence and privacy files from the live service", async (t) => {
  const paths = [];
  // Intercept the write boundary even on the broken implementation: a RED test
  // must never reproduce this bug by actually changing the operator's state.
  t.mock.method(Presence.prototype, "leave", async function () {
    paths.push({ stateFile: this.stateFile, privacyFile: this.privacyFile });
  });
  await runAll({ cases: [{ id: "isolated-leave", title: "Isolated leave", steps: [
    { speaker: "owner", text: "Jester, leave.", expect: { writes: 0 } },
  ] }] });
  assert.ok(paths.length > 0, "the leave boundary was exercised");
  for (const pathsUsed of paths) {
    assert.notEqual(pathsUsed.stateFile, join(homedir(), ".local/share/jester-voice/presence.json"));
    assert.notEqual(pathsUsed.privacyFile, join(homedir(), ".local/share/jester-voice/privacy.json"));
  }
});

test("the three voice-behaviour scenarios exist and are well-formed", async () => {
  const { scenarios } = await import("./scenarios.mjs");
  const { validateScenario } = await import("./run.mjs");
  const { BRAIN_OUT_LINE } = await import("../src/owner-router.mjs");
  for (const scenario of scenarios) assert.deepEqual(validateScenario(scenario), [], scenario.id);
  const byId = Object.fromEntries(scenarios.map(item => [item.id, item]));

  const hum = byId["hum-during-answer"];
  assert.ok(hum?.holdPlayback, "hum scenario holds playback so the answer is still playing");
  const humStep = hum.steps.at(-1);
  assert.deepEqual(humStep.events.map(event => event.ev), ["speech_start", "pause", "turn_end"]);
  assert.match(humStep.events[1].text, /mm-hmm/i);
  assert.equal(humStep.release, true);
  assert.equal(humStep.expect.brain, 0);
  assert.equal(humStep.expect.stops, 0);
  assert.ok(humStep.expect.says.length, "the rest of the answer is spoken");

  const stop = byId["stop-mid-answer"];
  assert.ok(stop?.holdPlayback);
  const stopStep = stop.steps.at(-1);
  assert.match(stopStep.events.find(event => event.ev === "pause").text, /^jester, stop/i);
  assert.equal(stopStep.expect.stopOn, "pause");
  assert.equal(stopStep.expect.brain, 0);
  assert.equal(stopStep.expect.writes, 0);

  const down = byId["luna-down-reads"];
  assert.equal(down?.brainFailure, "usageLimitExceeded");
  assert.equal(down.rows.filter(row => !row.closed).length, 2);
  const [list, see, weather] = down.steps;
  assert.match(list.text, /what's open/i);
  assert.equal(list.expect.brain, 0);
  assert.ok(list.expect.saysNot.length, "closed rows are not named");
  assert.match(see.text, /do you see podlox/i);
  assert.ok(see.expect.says.includes("yes"));
  assert.match(weather.text, /weather/i);
  assert.deepEqual(weather.expect.says, [BRAIN_OUT_LINE]);
  for (const step of down.steps) {
    assert.equal(step.expect.writes, 0);
    assert.equal(step.expect.brainAnswers, 0);
  }
});

test("validateScenario rejects unknown events and expectation keys", async () => {
  const { validateScenario } = await import("./run.mjs");
  assert.deepEqual(validateScenario({ id: "ok", title: "Ok", steps: [
    { speaker: "owner", text: "hi", expect: { writes: 0 } }] }), []);
  const problems = validateScenario({ id: "bad", title: "Bad", steps: [
    { speaker: "owner", events: [{ ev: "bogus" }], expect: { nonsense: 1 } }] });
  assert.ok(problems.some(item => item.includes("bogus")));
  assert.ok(problems.some(item => item.includes("nonsense")));
});

test("grade checks brain answers, stops, excluded speech and the room transcript", () => {
  const actual = { speech: ["Two open sessions: podlox; Old Site."], writes: [], brain: ["q"], brainAnswers: 1,
    watches: [], groups: [], muted: false, disconnected: false, stops: 2, stopEvents: [],
    transcript: ["Drew: Mm-hmm."] };
  const failures = grade({ brainAnswers: 0, stops: 0, stopOn: "pause", saysNot: ["Old Site"],
    transcriptOmits: ["mm-hmm"] }, actual);
  assert.ok(failures.some(reason => reason.includes("Luna answers")));
  assert.ok(failures.some(reason => reason.includes("playback stops")));
  assert.ok(failures.some(reason => reason.includes("pause")));
  assert.ok(failures.some(reason => reason.includes("Old Site")));
  assert.ok(failures.some(reason => reason.includes("transcript")));
  assert.deepEqual(grade({ brainAnswers: 0, stops: 1, stopOn: "pause" },
    { ...actual, brainAnswers: 0, stops: 1, stopEvents: ["pause"] }), []);
});
