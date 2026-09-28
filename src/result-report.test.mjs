import assert from "node:assert/strict";
import test from "node:test";
import { buildResultReport } from "./result-report.mjs";

const zoro = "1553779983158349925";
const sanji = "1554149594718281869";

test("quotes only explicit recent test steps and labels each exact session", () => {
  const watch = { createdAt: "2026-09-28T12:00:00Z",
    sources: [{ threadId: zoro, label: "zoro" }, { threadId: sanji, label: "sanji" }],
    completed: { [zoro]: { status: "accepted" }, [sanji]: { status: "failed" } } };
  const responses = new Map([[zoro, { messages: [
    { is_bot: true, content: "Run old tests", created_at: "2026-09-28T11:00:00Z" },
    { is_bot: false, content: "Test production", created_at: "2026-09-28T12:01:00Z" },
    { is_bot: true, content: "Done.\n- Open the local login page\n- Verify the reset link",
      created_at: "2026-09-28T12:02:00Z",
      jump_url: `https://discord.com/channels/1/${zoro}/2` },
  ] }]]);
  const report = buildResultReport(watch, responses);
  assert.deepEqual(report.entries[0].steps, ["Open the local login page", "Verify the reset link"]);
  assert.equal(report.entries[1].status, "failed");
  assert.match(report.markdown, /## zoro/);
  assert.match(report.markdown, /## sanji/);
  assert.doesNotMatch(report.markdown, /Run old tests|Test production/);
  assert.match(report.spoken, /zoro: Open the local login page/);
  assert.equal(report.missingReplies, false);
});
