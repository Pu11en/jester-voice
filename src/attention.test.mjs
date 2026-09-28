import assert from "node:assert/strict";
import test from "node:test";
import { Attention, FOLLOW_UP_MS, modeCommand, possibleModeCommand } from "./attention.mjs";

test("mode commands require a complete direct Jester address", () => {
  for (const text of ["Jester, just listen", "Hey, Jester! Just listen.", "jester just listen!"]) {
    assert.equal(modeCommand(text), "transcript", text);
  }
  for (const text of ["Jester, talk again", "Hey Jester, talk again!"]) {
    assert.equal(modeCommand(text), "conversation", text);
  }
  for (const text of ["just listen", "talk again", "I told Jester to just listen",
    "Jester, just listen for a minute", "Jester, talk again after lunch", "Jester, leave"]) {
    assert.equal(modeCommand(text), null, text);
  }
  for (const text of ["Jester", "Jester, just", "Jester, just lis", "Jester, talk aga"]) {
    assert.equal(possibleModeCommand(text), true, text);
  }
  assert.equal(possibleModeCommand("Jester, just explain"), false);
});

test("only a direct Jester address wakes, with a strict 60-second follow-up boundary", () => {
  let now = 0;
  const attention = new Attention(() => now);
  for (const text of ["Room talk", "Zoro, fix it", "I mentioned Jester yesterday", "Jesterish", "Hey Alex, ask Jester"]) {
    assert.equal(attention.accept(text), false, text);
  }
  assert.equal(attention.accept("Hey, Jester! Can you help?"), true);
  now = FOLLOW_UP_MS - 1;
  assert.equal(attention.classify("What about tomorrow?"), "conversation");
  now += 1;
  assert.equal(attention.accept("What about tomorrow?"), false);
  assert.equal(attention.accept("Zoro, fix it"), false);
  assert.equal(attention.accept("Jester"), true);
  assert.equal(attention.accept("Zoro, fix it"), true);
  assert.equal(attention.accept("Frankie, check the build"), true);
  attention.setSessionTags(["nami"]);
  assert.equal(attention.accept("Nami, check the build"), true);
  assert.equal(attention.accept("Alex, pass the salt"), false);
});

test("explicit side talk never refreshes attention, and clear endings re-arm the name gate", () => {
  let now = 0;
  const attention = new Attention(() => now);
  attention.accept("Jester");
  now = 50_000;
  for (const text of ["Hey Alex, pass the salt", "Guys, dinner is ready", "I'm talking to Alex", "That wasn't for you"]) {
    assert.equal(attention.accept(text), false, text);
  }
  now = FOLLOW_UP_MS;
  assert.equal(attention.engaged, false);
  for (const text of ["That's all", "Okay, that's all for now, thanks", "Thanks, Jester!", "Jester, goodbye", "Goodbye, thanks", "Never mind", "We're done"]) {
    attention.accept("Jester");
    assert.equal(attention.accept(text), false, text);
    assert.equal(attention.engaged, false, text);
  }
  attention.accept("Jester");
  assert.equal(attention.accept("Thanks, can you explain the second part?"), true);
  assert.equal(attention.accept("What does goodbye mean?"), true);
});

test("named side addresses stay ambient while greeting-led follow-ups refresh attention", () => {
  let now = 0;
  const attention = new Attention(() => now);
  attention.accept("Jester");
  now = 50_000;
  for (const text of ["Alex, pass the salt", "alex, pass the salt", "Hey Alex, pass the salt",
    "Hey, Alex, pass the salt", "Hey Alex can you help", "María, dinner is ready"]) {
    assert.equal(attention.classify(text), "ambient", text);
    assert.equal(attention.accept(text), false, text);
    assert.equal(attention.until, FOLLOW_UP_MS, text);
  }
  now = FOLLOW_UP_MS;
  assert.equal(attention.engaged, false);
  assert.equal(attention.accept("Hey can you clarify that?"), false, "a greeting alone cannot wake Jester");
  attention.accept("Jester");
  for (const text of ["Hey can you clarify that?", "Hey, can you clarify that?",
    "Hey could you explain?", "Hey what does that mean?", "Hey I have another question",
    "Okay, explain that again", "Well, what about tomorrow?", "Actually, explain the second part",
    "Thanks, can you clarify?"]) {
    now += 1000;
    assert.equal(attention.classify(text), "conversation", text);
    assert.equal(attention.accept(text), true, text);
    assert.equal(attention.until, now + FOLLOW_UP_MS, text);
  }
});
