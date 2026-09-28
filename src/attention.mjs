export const FOLLOW_UP_MS = 60_000;

const ADDRESS = /^(?:(?:hey|hi|hello|okay|ok|yo)\s*[,!.]?\s+)?jester\b[\s,!.:;-]*/i;
const ENDING = /^(?:(?:okay|ok|thanks|thank you)[,\s]+)*(?:that['’]?s all(?: for now)?|we['’]?re done|goodbye|bye(?: for now)?|never mind|nevermind|stop talking)(?:[,\s]+(?:thanks|thank you|jester))*[.!?]*$/i;
const THANKS = /^(?:thanks|thank you)(?:[,\s]+jester)?[.!?]*$/i;
const LEAVE = /^(?:leave|disconnect)[.!?]*$/i;
const JUST_LISTEN = /^just listen[.!?]*$/i;
const TALK_AGAIN = /^talk again[.!?]*$/i;
const SIDE_TALK = /^(?:(?:everyone|everybody|guys|folks)\b|(?:i(?:['’]m| am)\s+talking\s+to|(?:this|that)\s+was(?:n['’]t| not)\s+for\s+you)\b)/i;
const GREETING = /^(?:hey|hi|hello|yo)\b[\s,!.]*/i;
// A greeting alone isn't a side address: "Hey can you ..." is a follow-up.
// Likewise, discourse words before a comma ("Okay, ...") aren't names.
const FOLLOW_UP_START = new Set((
  "a an the i i'm i've i'd i'll you you're you've you'd you'll we we're we've we'd we'll " +
  "it it's they they're he she this that that's these those there here's here " +
  "can could would will should shall may might must do does did don't is isn't are aren't was were " +
  "what what's why how who's who where when which whose whether " +
  "okay ok yes yeah yep no nope sure right well actually also and but so then now " +
  "thanks thank please sorry wait hold stop never nevermind explain clarify tell show help " +
  "repeat say give go try let's just one first next instead maybe perhaps honestly basically"
).split(" "));

function isSideTalk(text, sessionTags) {
  const greeting = GREETING.test(text);
  const body = greeting ? text.replace(GREETING, "").trim() : text;
  if (SIDE_TALK.test(body)) return true;
  const candidate = /^([\p{L}][\p{L}'’\-]*)(?=\s|[,!?]|$)(\s*,)?/u.exec(body);
  if (!candidate || (!greeting && !candidate[2])) return false;
  const word = candidate[1].toLowerCase().replaceAll("’", "'");
  // A current EBI tag stays available to the later router during an exchange.
  // Dormant speech is rejected before this check; this gate never dispatches work.
  if (!greeting && sessionTags.has(word)) return false;
  return !FOLLOW_UP_START.has(word);
}

/** Mode commands require a direct address and a complete owner turn. */
export function modeCommand(text) {
  const trimmed = String(text || "").trim();
  if (!ADDRESS.test(trimmed)) return null;
  const body = trimmed.replace(ADDRESS, "").trim();
  if (JUST_LISTEN.test(body)) return "transcript";
  if (TALK_AGAIN.test(body)) return "conversation";
  return null;
}

/** Keep incomplete mode commands out of speculative Luna requests. */
export function possibleModeCommand(text) {
  const trimmed = String(text || "").trim();
  if (!ADDRESS.test(trimmed)) return false;
  const body = trimmed.replace(ADDRESS, "").trim().replace(/[.!?]+$/, "").toLowerCase();
  return "just listen".startsWith(body) || "talk again".startsWith(body);
}

/** Local owner-only gate. Transcription happens independently of this state. */
export class Attention {
  constructor(now, sessionTags = ["zoro", "frankie", "franky"]) {
    this.now = now;
    this.setSessionTags(sessionTags);
    this.reset();
  }

  setSessionTags(tags) {
    this.sessionTags = new Set([...tags].map(tag => String(tag).toLowerCase()));
  }

  reset() { this.until = null; }

  get engaged() { return this.until !== null && this.now() < this.until; }

  classify(text) {
    const trimmed = text.trim();
    const addressed = ADDRESS.test(trimmed);
    const body = addressed ? trimmed.replace(ADDRESS, "").trim() : trimmed;
    if (!addressed && !this.engaged) return "ambient";
    if (ENDING.test(body) || THANKS.test(body)) return "ending";
    if (!addressed && isSideTalk(body, this.sessionTags)) return "ambient";
    if (addressed && LEAVE.test(body)) return "control";
    return "conversation";
  }

  accept(text) {
    const kind = this.classify(text);
    if (kind === "ending" || kind === "control") this.reset();
    if (kind !== "conversation") return false;
    this.refresh();
    return true;
  }

  refresh() { this.until = this.now() + FOLLOW_UP_MS; }
}
