#!/usr/bin/env node
// A scripted stand-in for `claude -p --input-format stream-json --output-format stream-json
// --include-partial-messages`: reads user messages as JSON lines on stdin and answers with
// the line types the real CLI emits (system/init, stream_event, assistant, result,
// control_response). Scenarios are keyed by a phrase in the prompt, like fake-app-server.mjs.
import { createInterface } from "node:readline";

const SESSION_ID = "fake-session";
const MODEL = "fake-model";
let eventNumber = 0;
let current = null; // the in-flight turn: { timers, ignoreInterrupt, text }

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function later(fn, delay) {
  const timer = setTimeout(fn, delay);
  current?.timers.push(timer);
  return timer;
}

function streamEvent(event) {
  write({ type: "stream_event", event, session_id: SESSION_ID, uuid: `evt-${++eventNumber}` });
}

const delta = (text, delay) => later(() => streamEvent({
  type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
}), delay);

const assistant = (text, delay, error = null) => later(() => write({
  type: "assistant",
  message: { role: "assistant", model: MODEL, content: [{ type: "text", text }], stop_reason: "end_turn" },
  ...(error ? { error } : {}),
  session_id: SESSION_ID,
  uuid: `msg-${++eventNumber}`,
}), delay);

const rateLimit = (status, delay) => later(() => write({
  type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
  session_id: SESSION_ID, uuid: `rl-${++eventNumber}`,
}), delay);

const result = (fields, delay) => later(() => {
  write({ type: "result", session_id: SESSION_ID, duration_ms: 5, duration_api_ms: 4, num_turns: 1,
    api_error_status: null, stop_reason: "end_turn", ...fields });
  current = null;
}, delay);

const success = (text, delay) => result({ subtype: "success", is_error: false, result: text }, delay);
const failure = (fields, delay) => result({ subtype: "error_during_execution", is_error: true,
  ...fields }, delay);

/** What the real CLI streams before the first text delta: a thinking block and its own
 *  assistant line, which a voice brain must skip without treating them as words. */
function startEvents() {
  write({ type: "system", subtype: "status", status: "thinking", session_id: SESSION_ID });
  streamEvent({ type: "message_start", message: { role: "assistant", model: MODEL, content: [] } });
  streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  write({ type: "system", subtype: "thinking_tokens", estimated_tokens: 12, session_id: SESSION_ID });
  streamEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "Mm, a greeting. " } });
  streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
  streamEvent({ type: "content_block_stop", index: 0 });
  write({ type: "assistant", message: { role: "assistant", model: MODEL, stop_reason: null,
    content: [{ type: "thinking", thinking: "Mm, a greeting. ", signature: "sig" }] }, session_id: SESSION_ID });
  streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
}

function endEvents(delay) {
  later(() => {
    streamEvent({ type: "content_block_stop", index: 0 });
    streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    streamEvent({ type: "message_stop" });
  }, delay);
}

/** Stream a full answer: deltas, the assistant message and a successful result. */
function answer(text, start = 0) {
  startEvents();
  delta(text.slice(0, 7), start + 5);
  delta(text.slice(7), start + 10);
  endEvents(start + 12);
  assistant(text, start + 13);
  rateLimit("allowed", start + 14);
  success(text, start + 15);
}

function runTurn(text) {
  current = { timers: [], ignoreInterrupt: false, text };
  // The real CLI announces the session again for every user message.
  write({ type: "system", subtype: "init", session_id: SESSION_ID, model: MODEL, tools: [],
    cwd: process.cwd(), permissionMode: "default", apiKeySource: "none" });
  if (text.includes("hang forever")) return;
  if (text.includes("api limit")) {
    rateLimit("rejected", 5);
    failure({ api_error_status: 429, errors: ["API Error: 429"] }, 10);
    return;
  }
  if (text.includes("server error")) {
    failure({ api_error_status: 529, errors: ["API Error: 529 Overloaded"] }, 5);
    return;
  }
  if (text.includes("exit now")) {
    later(() => process.exit(3), 5);
    return;
  }
  if (text.includes("ignores interrupt") || text.includes("long reply")) {
    current.ignoreInterrupt = text.includes("ignores interrupt");
    startEvents();
    delta("Starting now. ", 5);
    return;
  }
  if (text.includes("delayed reply")) {
    startEvents();
    delta("A little later.", 60);
    endEvents(65);
    assistant("A little later.", 66);
    success("A little later.", 70);
    return;
  }
  if (text.includes("failed turn")) {
    failure({ errors: ["Something broke"] }, 5);
    return;
  }
  if (text.includes("usage limit")) {
    const text = "You've hit your usage limit. Your limit will reset at 3pm.";
    assistant(text, 5, "rate_limit");
    failure({ result: text, errors: [text] }, 10);
    return;
  }
  if (text.includes("auth failure")) {
    assistant("Not logged in. Please run /login.", 5, "authentication_failed");
    failure({ errors: ["Not logged in. Please run /login."] }, 10);
    return;
  }
  if (text.includes("streamed limit")) {
    startEvents();
    delta("You've hit your usage limit. ", 5);
    delta("Upgrade or try again at 3:15 PM.", 10);
    endEvents(12);
    success("You've hit your usage limit. Upgrade or try again at 3:15 PM.", 15);
    return;
  }
  if (text.includes("filler reply")) {
    startEvents();
    delta("Mm-hmm. ", 5);
    delta("I'm here when you're ready.", 10);
    endEvents(12);
    success("Mm-hmm. I'm here when you're ready.", 15);
    return;
  }
  if (text.includes("only filler")) {
    startEvents();
    delta("Mm-hmm.", 5);
    success("Mm-hmm.", 10);
    return;
  }
  if (text.includes("comma filler")) {
    startEvents();
    delta("Uh-huh, ", 5);
    delta("that works.", 10);
    success("Uh-huh, that works.", 15);
    return;
  }
  if (text.includes("slow stream")) {
    startEvents();
    delta("First part. ", 5);
    delta("Second part. ", 75);
    delta("Third part.", 145);
    success("First part. Second part. Third part.", 150);
    return;
  }
  answer(text.includes("heard before") ? "Context kept." : "Hello there. How can I help?");
}

function interrupt(requestId) {
  if (current?.ignoreInterrupt) return;
  write({ type: "control_response", response: { subtype: "success", request_id: requestId,
    response: { still_queued: [] } } });
  if (!current) return;
  for (const timer of current.timers) clearTimeout(timer);
  const turn = current;
  current = null;
  streamEvent({ type: "content_block_stop", index: 0 });
  streamEvent({ type: "message_stop" });
  write({ type: "result", subtype: "success", is_error: false, result: "Starting now.", session_id: SESSION_ID,
    duration_ms: 5, num_turns: 1, interrupted: true, text: turn.text });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    const text = typeof content === "string" ? content
      : (content || []).map((block) => block.text ?? "").join("\n");
    runTurn(text);
  } else if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    interrupt(message.request_id);
  }
});
