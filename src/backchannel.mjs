// Pure helpers for listening sounds, stop phrases and bare answers. Jester never says
// a filler; Drew's fillers and bare acknowledgements are neither a stop nor a turn.

/** Listening sounds: never spoken by Jester, never a turn or a stop from Drew. */
export const FILLER_TOKENS = Object.freeze([
  "mm", "mhm", "mhmm", "mm-hm", "mm-hmm", "mmhmm", "hmm", "hm", "uh-huh", "uhhuh", "uh", "uhh",
  "um", "umm",
]);

/** Fillers plus bare acknowledgements; an answer only right after Jester asked a question. */
export const BACKCHANNEL_TOKENS = Object.freeze([
  ...FILLER_TOKENS, "yeah", "yep", "yup", "yes", "ok", "okay", "right", "sure", "alright",
]);

const FILLER = new Set(FILLER_TOKENS);
const BACKCHANNEL = new Set(BACKCHANNEL_TOKENS);
const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright", "right",
  "mm-hmm", "uh-huh", "mhm"]);
const NO = new Set(["no", "nope", "nah", "uh-uh"]);
const ANSWER_TAIL = ["please", "thanks", "jester"];
const YES_ANSWER = new Set([...YES, ...ANSWER_TAIL]);
const NO_ANSWER = new Set([...NO, ...ANSWER_TAIL]);

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const FIRST_WORD = /^[\s.!?,;:…—–-]*([\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*)/u;
const PUNCTUATION = /^[\s.!?,;:…—–-]+/;
// The transcriber sometimes spells the sound "uh huh"; a bare "huh" stays a real question.
const SPACED_UH_HUH = /\buh[\s-]+huh\b/gi;

// A bare stop while a reply plays: optional lead-in or address, the phrase (repeated is
// fine), an optional tail. "stop talking" is an ending phrase handled by attention.
const LEAD = "(?:(?:hey|hi|yo|okay|ok|oh|no|please|jester)[,!.:;\\s-]+)*";
const STOP_PHRASE = "(?:stop|shut up|hold on|hang on|wait)";
const TAIL = "(?:[,!.\\s]+(?:jester|please|now|a (?:sec|second|moment|minute)))*";
const STOP = new RegExp(`^${LEAD}${STOP_PHRASE}(?:[,!.\\s]+${STOP_PHRASE})*${TAIL}[.!?]*$`, "i");

/** Lowercase, straight apostrophes, letter runs shortened ("Hmmm" -> "hmm"). */
function normalize(word) {
  return word.toLowerCase().replaceAll("’", "'").replace(/(.)\1{2,}/g, "$1$1");
}

function spell(text) {
  return String(text || "").replace(SPACED_UH_HUH, "uh-huh");
}

function words(text) {
  return (spell(text).match(WORD) ?? []).map(normalize);
}

/** One or two words: the first from `first`, any second from `rest`. */
function shortUtterance(text, first, rest) {
  const list = words(text);
  return list.length >= 1 && list.length <= 2 && first.has(list[0]) &&
    list.slice(1).every(word => rest.has(word));
}

/** True for one or two listening tokens ("Mm-hmm.", "mm hmm", "Okay."), never a longer turn. */
export function isBackchannelOnly(text) {
  return shortUtterance(text, BACKCHANNEL, BACKCHANNEL);
}

/** True for a bare stop phrase ("Jester, stop.", "hold on"), never a command like "stop zoro". */
export function isStopSpeech(text) {
  return STOP.test(String(text || "").trim());
}

/** Drops fillers Jester must never open with: "Mm-hmm. I'm here." -> "I'm here.". */
export function stripLeadingBackchannel(text) {
  let rest = spell(text);
  let stripped = false;
  for (let match = FIRST_WORD.exec(rest); match && FILLER.has(normalize(match[1]));
    match = FIRST_WORD.exec(rest)) {
    rest = rest.slice(match[0].length);
    stripped = true;
  }
  return stripped ? rest.replace(PUNCTUATION, "") : rest;
}

/** A bare yes ("yeah", "Yes, please.", "Mm-hmm."), for right after Jester asked a question. */
export function isAffirmative(text) {
  return shortUtterance(text, YES, YES_ANSWER);
}

/** A bare no ("no", "nope", "No, thanks."), for right after Jester asked a question. */
export function isNegative(text) {
  return shortUtterance(text, NO, NO_ANSWER);
}
