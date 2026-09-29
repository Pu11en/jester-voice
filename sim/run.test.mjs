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
