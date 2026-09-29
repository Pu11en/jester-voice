#!/usr/bin/env node
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let turnNumber = 0;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function refuse(id, error) {
  write({ jsonrpc: "2.0", id, error });
}

function notice(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

const usageLimitError = {
  message: "You've hit your usage limit.",
  codexErrorInfo: { usageLimitExceeded: { limitId: "codex" } },
  additionalDetails: null,
};

/** Scripted turns keyed by a phrase in the prompt; anything else gets the stock reply. */
function runTurn(turnId, text) {
  const emit = (delta, delay) => setTimeout(() => notice("item/agentMessage/delta", {
    threadId: "fake-thread", turnId, delta,
  }), delay);
  const complete = (turn, delay) => setTimeout(() => notice("turn/completed", {
    threadId: "fake-thread", turnId, turn: { id: turnId, ...turn },
  }), delay);
  const error = (params, delay) => setTimeout(() => notice("error", {
    threadId: "fake-thread", turnId, ...params,
  }), delay);
  const done = (delay) => complete({ status: "completed" }, delay);

  if (text.includes("hang forever")) return;
  if (text.includes("long reply")) {
    emit("Starting now. ", 5);
    return;
  }
  if (text.includes("delayed reply")) {
    emit("A little later.", 60);
    done(70);
    return;
  }
  if (text.includes("failed turn plain")) {
    complete({ status: "failed" }, 5);
    return;
  }
  if (text.includes("failed turn")) {
    complete({ status: "failed", error: {
      message: "The model's context window was exceeded.",
      codexErrorInfo: "contextWindowExceeded",
      additionalDetails: null,
    } }, 5);
    return;
  }
  if (text.includes("nested error")) {
    error({ error: usageLimitError, willRetry: false }, 5);
    complete({ status: "failed", error: usageLimitError }, 10);
    return;
  }
  if (text.includes("streamed limit")) {
    emit("You've hit your usage limit. ", 5);
    emit("Upgrade to Pro or try again at 3:15 PM.", 10);
    done(15);
    return;
  }
  if (text.includes("filler reply")) {
    emit("Mm-hmm. ", 5);
    emit("I'm here when you're ready.", 10);
    done(15);
    return;
  }
  if (text.includes("only filler")) {
    emit("Mm-hmm.", 5);
    done(10);
    return;
  }
  if (text.includes("comma filler")) {
    emit("Uh-huh, ", 5);
    emit("that works.", 10);
    done(15);
    return;
  }
  if (text.includes("limit topic")) {
    emit("Add a rate limit to the login endpoint. ", 5);
    emit("The usage limit resets at midnight.", 10);
    done(15);
    return;
  }
  if (text.includes("slow stream")) {
    emit("First part. ", 5);
    emit("Second part. ", 75);
    emit("Third part.", 145);
    done(150);
    return;
  }
  const answer = text.includes("heard before")
    ? "Context kept."
    : "Hello there. How can I help?";
  let start = 0;
  if (text.includes("retrying error")) {
    error({ error: { message: "stream disconnected before completion", codexErrorInfo: null,
      additionalDetails: null }, willRetry: true }, 5);
    start = 10;
  }
  emit(answer.slice(0, 7), start + 5);
  emit(answer.slice(7), start + 10);
  done(start + 15);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, {});
  if (message.method === "thread/start") reply(message.id, { thread: { id: "fake-thread" } });
  if (message.method === "turn/start") {
    const text = message.params.input.map((item) => item.text).join("\n");
    if (text.includes("rejected start")) {
      refuse(message.id, { code: -32000, message: "Rate limit reached for gpt-6-luna. Try again later." });
      return;
    }
    turnNumber += 1;
    const turnId = `fake-turn-${turnNumber}`;
    reply(message.id, { turn: { id: turnId } });
    runTurn(turnId, text);
  }
  if (message.method === "turn/interrupt") {
    notice("turn/completed", {
      threadId: message.params.threadId,
      turnId: message.params.turnId,
      turn: { id: message.params.turnId, status: "interrupted" },
    });
    reply(message.id, {});
  }
});
