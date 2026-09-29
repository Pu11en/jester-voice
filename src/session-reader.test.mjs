import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionReader } from "./session-reader.mjs";

test("reads the substantive result and project guide, excluding later status notices", async () => {
  const project = await mkdtemp(join(tmpdir(), "jester-session-read-"));
  const calls = [];
  try {
    await writeFile(join(project, "AGENTS.md"), "This project audits local businesses.");
    const reader = new SessionReader({ client: { async threadMessages(id, limit) {
      calls.push([id, limit]);
      return [
        { is_bot: false, content: "Check the three candidates", jump_url: "https://discord.com/channels/g/t/1" },
        { is_bot: true, content: "I checked all three. The signs could not be verified online.",
          jump_url: "https://discord.com/channels/g/t/2", truncated: true },
        { is_bot: true, content: "-# Turn finished" },
        { is_bot: true, content: "🟡 <@123> The agent has finished — your reply is needed here." },
      ];
    } } });
    const text = await reader.read({ threadId: "1553779983158349925", tag: "zoro",
      state: "history", project, currentTask: "Check signs" });
    assert.deepEqual(calls, [["1553779983158349925", 40]]);
    assert.match(text, /checked all three/);
    assert.match(text, /CLIPPED/);
    assert.match(text, /audits local businesses/);
    assert.doesNotMatch(text, /reply is needed|Turn finished/);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("reports missing evidence without inventing a result", async () => {
  const reader = new SessionReader({ client: { async threadMessages() {
    return [{ is_bot: true, content: "-# Turn finished" }];
  } } });
  const text = await reader.read({ threadId: "1553779983158349925", tag: "zoro",
    state: "history", project: "", currentTask: "" });
  assert.match(text, /No substantive thread messages were available/);
  assert.match(text, /Current task field: unavailable/);
});

test("accepts the coming visibility field without changing today's evidence", async () => {
  const reader = new SessionReader({ client: { async threadMessages() { return []; } } });
  const base = { threadId: "1553779983158349925", tag: "zoro", state: "history", project: "", currentTask: "" };
  const today = await reader.read(base);
  assert.match(today, /state history\./);
  assert.doesNotMatch(today, /visible/i);
  const coming = await reader.read({ ...base, visible: false, closed: false, openCount: 24 });
  assert.match(coming, /state history; not visible in Discord\./);
  assert.match(await reader.read({ ...base, visible: true }), /state history; visible in Discord\./);
});
