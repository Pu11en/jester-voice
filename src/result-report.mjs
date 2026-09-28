const TEST_LINE = /^(?:[-*]\s*|\d+[.)]\s*)?(?:(?:to\s+test(?:\s+(?:it|this))?[,\s:]+)|(?:try|test|verify|check|open|run|click|confirm|use)\b|(?:you\s+can\s+(?:test|try|verify|check))\b)/iu;

function clean(line) {
  return line.trim().replace(/^[-*]\s*|^\d+[.)]\s*/u, "")
    .replace(/<@!?\d+>/gu, "a person").replace(/\s+/gu, " ").slice(0, 220);
}

/** Only quote explicit test instructions from bot replies after the watch began. */
export function testSteps(messages, since) {
  const start = Date.parse(since);
  const recent = messages.filter(message => message.is_bot && message.content?.trim() &&
    Number.isFinite(Date.parse(message.created_at)) && Date.parse(message.created_at) >= start);
  const lines = recent.flatMap(message => message.content.split("\n"));
  const steps = [...new Set(lines.filter(line => TEST_LINE.test(line.trim())).map(clean).filter(Boolean))];
  return { steps: steps.slice(-3), hasRecentReply: recent.length > 0,
    link: recent.at(-1)?.jump_url || messages.filter(m => m.jump_url).at(-1)?.jump_url || null };
}

export function buildResultReport(watch, responses) {
  const entries = watch.sources.map(source => {
    const terminal = watch.completed[source.threadId];
    const response = responses.get(source.threadId) || {};
    const extracted = terminal?.status === "accepted" && Array.isArray(response.messages)
      ? testSteps(response.messages, watch.createdAt) :
      { steps: [], hasRecentReply: false, link: null };
    return { ...source, status: terminal?.status || "unknown", ...extracted,
      error: response.error || null };
  });
  const lines = ["# Jester: what to test", "", "Test steps below are quoted from each session's visible reply; Jester has not run them.", ""];
  for (const entry of entries) {
    lines.push(`## ${entry.label}`, "");
    if (entry.link?.startsWith("https://discord.com/channels/")) lines.push(`Thread: ${entry.link}`, "");
    else lines.push(`Thread ID: ${entry.threadId}`, "");
    if (entry.status === "failed") lines.push("This turn stopped or may have failed; check its thread before testing.");
    else if (entry.error) lines.push("I could not read its final reply; check the thread for test steps.");
    else if (!entry.hasRecentReply) lines.push("No final reply was visible yet; check the thread for test steps.");
    else if (!entry.steps.length) lines.push("Its visible reply did not give explicit test steps.");
    else for (const step of entry.steps) lines.push(`- ${step}`);
    lines.push("");
  }
  const failed = entries.filter(e => e.status === "failed").length;
  const withSteps = entries.filter(e => e.steps.length).length;
  let spoken = `The ${entries.length} watched ${entries.length === 1 ? "session has" : "sessions have"} finished.`;
  if (failed) spoken += ` ${failed} ${failed === 1 ? "turn may need" : "turns may need"} attention.`;
  if (entries.length <= 3 && withSteps) {
    const brief = entries.filter(e => e.steps.length).map(e =>
      `${e.label}: ${e.steps[0].slice(0, 100)}`).join(" ");
    spoken += ` Test steps from their replies: ${brief}`;
  } else if (!withSteps) spoken += " I found no explicit test steps in the visible replies.";
  spoken += " I posted the per-session details in Auto Transcripts.";
  return { entries, markdown: lines.join("\n"), spoken,
    missingReplies: entries.some(e => e.status === "accepted" && !e.hasRecentReply && !e.error) };
}
