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

function notice(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, {});
  if (message.method === "thread/start") reply(message.id, { thread: { id: "fake-thread" } });
  if (message.method === "turn/start") {
    turnNumber += 1;
    const turnId = `fake-turn-${turnNumber}`;
    const text = message.params.input.map((item) => item.text).join("\n");
    reply(message.id, { turn: { id: turnId } });
    const emit = (delta, delay) => setTimeout(() => notice("item/agentMessage/delta", {
      threadId: "fake-thread", turnId, delta,
    }), delay);
    if (text.includes("long reply")) {
      emit("Starting now. ", 5);
      return;
    }
    if (text.includes("delayed reply")) {
      emit("A little later.", 60);
      setTimeout(() => notice("turn/completed", {
        threadId: "fake-thread", turnId, turn: { status: "completed" },
      }), 70);
      return;
    }
    const answer = text.includes("heard before")
      ? "Context kept."
      : "Hello there. How can I help?";
    emit(answer.slice(0, 7), 5);
    emit(answer.slice(7), 10);
    setTimeout(() => notice("turn/completed", {
      threadId: "fake-thread", turnId, turn: { status: "completed" },
    }), 15);
  }
  if (message.method === "turn/interrupt") {
    notice("turn/completed", {
      threadId: message.params.threadId,
      turnId: message.params.turnId,
      turn: { status: "interrupted" },
    });
    reply(message.id, {});
  }
});
