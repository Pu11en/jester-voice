import assert from "node:assert/strict";
import test from "node:test";
import { grade } from "./run.mjs";

test("simulation flags an extra action, wrong destination, and unsupported spoken claim", () => {
  const actual = { speech: ["I posted it to Zoro."], writes: [
    { kind: "spoken", target: "franky", threadId: "1553899450227757156", text: "deploy" },
  ], brain: [], watches: [], groups: [], muted: false, disconnected: false };
  const failures = grade({ silence: true, writes: 0, writeThreadId: "1553779983158349925" }, actual);
  assert.ok(failures.some(reason => reason.startsWith("Spoke:")));
  assert.ok(failures.some(reason => reason.includes("EBI writes")));
  assert.ok(failures.some(reason => reason.includes("thread ID")));
});
