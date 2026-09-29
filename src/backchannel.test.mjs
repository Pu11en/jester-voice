import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKCHANNEL_TOKENS, FILLER_TOKENS, isAffirmative, isBackchannelOnly, isNegative, isStopSpeech,
  stripLeadingBackchannel,
} from "./backchannel.mjs";

test("backchannel-only speech is one or two listening tokens in any case or punctuation", () => {
  for (const text of ["Mm-hmm.", "Mm.", "mm hmm", "uh-huh", "Hmm", "Yeah.", "Okay.", "ok", "yep",
    "right.", "MM-HMM!", "Hmmm...", "Mmm.", "Mm-hm.", "Uh huh.", "Mhmm.", "Umm.", "Uhh...", "Okay, yeah.", "Uh-huh, uh-huh.", "  yeah  "]) {
    assert.equal(isBackchannelOnly(text), true, text);
  }
  // "No." is a contentful answer and "Huh?" a question, not listening sounds; both stay real turns.
  for (const text of ["Yeah, so I need you to check Zoro", "Uh yeah, open a thread in the jobs folder",
    "No, pod locks.", "Jester?", "No.", "Huh?", "yeah yeah yeah", "Yeah, Jester.", "", "   ", "...", null, undefined]) {
    assert.equal(isBackchannelOnly(text), false, String(text));
  }
});

test("stop speech is a bare stop phrase, optionally addressed, never a longer command", () => {
  for (const text of ["Jester, stop.", "Stop.", "stop", "shut up", "hold on", "hang on", "wait", "okay stop",
    "STOP", "Hey Jester, hold on!", "Stop, Jester.", "Wait, wait.", "stop stop stop", "Hold on a second",
    "No, wait.", "Please stop.", "Jester stop", "  stop  "]) {
    assert.equal(isStopSpeech(text), true, text);
  }
  // "stop talking" is an ending phrase handled by attention, not a barge-in stop.
  for (const text of ["stop zoro", "stop talking", "stop the build in podlox", "Jester, stop talking",
    "Jester?", "Jester", "Wait, what did you say?", "hold", "stop it now please thanks", "", null]) {
    assert.equal(isStopSpeech(text), false, String(text));
  }
});

test("a leading filler is stripped from Jester's reply and acknowledgements are kept", () => {
  assert.equal(stripLeadingBackchannel("Mm-hmm. I'm here."), "I'm here.");
  assert.equal(stripLeadingBackchannel("Mm-hmm."), "");
  assert.equal(stripLeadingBackchannel("Sure, here it is."), "Sure, here it is.");
  assert.equal(stripLeadingBackchannel("Yeah, I'm here."), "Yeah, I'm here.");
  assert.equal(stripLeadingBackchannel("Uh-huh, hmm... I think so."), "I think so.");
  assert.equal(stripLeadingBackchannel("Uh huh, I'm here."), "I'm here.");
  assert.equal(stripLeadingBackchannel("Hmmm? Zoro is still running."), "Zoro is still running.");
  assert.equal(stripLeadingBackchannel("Um, no."), "no.");
  assert.equal(stripLeadingBackchannel("Mmm. Hmm."), "");
  assert.equal(stripLeadingBackchannel("The hmm is not leading."), "The hmm is not leading.");
  assert.equal(stripLeadingBackchannel("Mm-hmm"), "");
  assert.equal(stripLeadingBackchannel(""), "");
  assert.equal(stripLeadingBackchannel(null), "");
});

test("bare yes and no answers, with a polite or addressed tail, are recognised", () => {
  for (const text of ["yeah", "yes", "yep", "sure", "ok", "Okay.", "Yes, please.", "yeah sure",
    "Mm-hmm.", "uh huh", "Yes, Jester."]) {
    assert.equal(isAffirmative(text), true, text);
    assert.equal(isNegative(text), false, text);
  }
  for (const text of ["no", "nope", "nah", "No.", "No, thanks.", "Nope, Jester."]) {
    assert.equal(isNegative(text), true, text);
    assert.equal(isAffirmative(text), false, text);
  }
  for (const text of ["yes, send it", "No, pod locks.", "yeah no", "hmm", "please", "", null]) {
    assert.equal(isAffirmative(text), false, String(text));
    assert.equal(isNegative(text), false, String(text));
  }
  // A bare "Yeah." is a backchannel unless Jester just asked a question; the caller decides.
  assert.equal(isBackchannelOnly("Yeah."), true);
  assert.equal(isAffirmative("Yeah."), true);
});

test("token lists are exported lowercase and frozen for reuse", () => {
  assert.ok(FILLER_TOKENS.includes("mm-hmm"));
  assert.ok(FILLER_TOKENS.includes("uh-huh"));
  assert.ok(!FILLER_TOKENS.includes("yeah"));
  assert.ok(BACKCHANNEL_TOKENS.includes("yeah"));
  assert.ok(FILLER_TOKENS.every(token => BACKCHANNEL_TOKENS.includes(token)));
  for (const token of BACKCHANNEL_TOKENS) assert.equal(token, token.toLowerCase(), token);
  assert.ok(Object.isFrozen(FILLER_TOKENS));
  assert.ok(Object.isFrozen(BACKCHANNEL_TOKENS));
});
