const WAKE = /^(?:(?:hey|hi|hello|okay|ok|yo)\s*[,!.]?\s+)?jester\b[\s,!.:;—–-]*/i;
const NAME = "([\\p{L}][\\p{L}\\p{N}'-]*)";
const statusOne = new RegExp(`^(?:what(?:'s| is) |what is )${NAME} (?:doing|working on|up to)[?.!]*$`, "iu");
const statusNatural = new RegExp(`^what(?:'s| is) (?:going on|happening) with ${NAME}[?.!]*$`, "iu");
const statusLast = /^(?:what did (?:it|he|she|they) finish|what (?:did|has) (?:it|he|she|they) (?:done|complete))[?.!]*$/iu;
const discussNatural = /^help me with ([\p{L}][\p{L}\p{N}-]*)(?:['’]s)?(?:\s+.+)?[?.!]*$/iu;
const discussSession = new RegExp(`^(?:help me (?:figure out|understand)|can you help me with|let's discuss|let's talk about).+?\\b(?:i mean|actually)\\s+${NAME}[?.!]*$`, "iu");
const CORRECTION = new RegExp(`^(?:actually|no|wait|rather)\\s+${NAME}\\s*[,;:—–-]*\\s*`, "iu");
const TARGET_CORRECTION = new RegExp(`[,;:—–-]\\s*(?:wait|actually|no)\\s*[,;:—–-]?\\s*${NAME}\\s*[,;:—–-]+\\s*`, "iu");
const TELL = new RegExp(`^(?:and\\s+)?(?:tell|ask|message)\\s+${NAME}(?:\\s+to\\s+|\\s+that\\s+|[,;:—–-]\\s*|\\s+|$)`, "iu");
const DIRECT = new RegExp(`^(?:and\\s+)?${NAME}\\s*[,;:!?—–-]\\s*`, "iu");
const STOP = new RegExp(`^(?:stop|interrupt)(?:\\s+the)?(?:\\s+current)?(?:\\s+turn\\s+(?:in|for))?\\s+${NAME}[?.!]*$`, "iu");
const CLOSE = new RegExp(`^(?:close|archive|end)(?:\\s+the)?(?:\\s+session)?\\s+${NAME}[?.!]*$`, "iu");
const RUNTIME = new RegExp(`^(?:switch|set|move)\\s+${NAME}\\s+(?:to|onto)\\s+(codex|claude|sonnet|deepseek|dsh)(?:\\s+(sonnet|opus|haiku|auto))?[?.!]*$`, "iu");
const CREATE = /^(?:start|create|open|make)(?: me)?(?: a)?(?: new)? session (?:in|for) (.+?)(?: (?:using|with) (codex|claude|sonnet|deepseek|dsh)(?: (sonnet|opus|haiku|auto))?)? (?:to|and (?:ask|tell) (?:it|them) to) (.+)$/iu;
const CREATE_EMPTY = /^(?:start|create|open|make)(?: me)?(?: an?| the)?(?: new)? (?:empty|blank) (?:session|thread) (?:in|for) (.+?)(?: (?:using|with) (codex|claude|sonnet|deepseek|dsh)(?: (sonnet|opus|haiku|auto))?)?[?.!]*$/iu;
const HISTORY = /^(?:find|look up|search for)(?: the)? (?:session|thread)(?: where we| that| about| for)? (.+?)[?.!]*$/iu;
// Bare "find X" is a session lookup (Drew's decision); "find out ..." stays conversation.
const HISTORY_BARE = /^(?:find|look up|look for|search for|search)(?!\s+out\b)(?: me)?(?: the| an?| my| our)?(?: open)? (.+?)(?: (?:session|thread))?[?.!]*$/iu;
// Model-free session questions. Leading discourse words ("Like what sessions ...") are dropped first.
const FILLER = /^(?:(?:like|so|okay|ok|and|um|uh|yeah|well|alright|just|hey)[,\s]+)+/iu;
const LIST_OPEN = [
  /^what(?:'s| is)(?: currently| actually| all)? open(?: right now| now| currently| at the moment| today)?[?.!]*$/iu,
  /^(?:what|which)(?: all)? (?:sessions?|threads?)(?: do (?:we|i) have| are| is| that are| that's| which are| we have| i have)?(?: currently| actually| still| really)? open(?: right now| now| currently| at the moment)?[?.!]*$/iu,
  /^what do (?:we|i) have open(?: right now| now| currently)?[?.!]*$/iu,
  /^(?:list|show me|show|name|read me|tell me|give me)(?: all(?: of)?)?(?: the| my| our)?(?: currently| actually)?(?: open| active)? (?:sessions|threads)(?: (?:that are |which are )?(?:currently )?open)?(?: right now| now)?[?.!]*$/iu,
  /^how many (?:sessions|threads)(?: do (?:we|i) have| are)(?: currently| actually)? open(?: right now| now)?[?.!]*$/iu,
  /^(?=.*\bopen\b)(?:do (?:we|i|you) have|are there|is there|are)(?: any| anything| some)?(?: (?:open |active )?(?:sessions?|threads?))?(?: (?:that are |which are )?(?:currently |still )?open)?[?.!]*$/iu,
];
const SEE_ONE = [
  // "Can you have Zoro run the tests?" asks for work, so only "do you have X" is a question.
  /^(?:(?:do|can|could) you (?:still )?(?:see|find)|do you (?:still )?have)(?: an?| the| my)? (.+?)(?: (?:session|thread))?(?: open| in there| there| listed| anywhere)?[?.!]*$/iu,
  /^(?:do|did) (?:we|i) (?:still )?have(?: an?| the| my)? (.+?)(?: (?:session|thread))?(?: still)?(?: open)?[?.!]*$/iu,
  /^is(?: there)?(?: an?| the| my)? (.+?)(?: (?:session|thread))? (?:still )?(?:open|listed)[?.!]*$/iu,
  /^is there (?:an?|any) (?:session|thread) (?:for|called|named|on|about) (.+?)[?.!]*$/iu,
];
const SEE_ONE_PRONOUNS = new Set(["it", "him", "her", "them", "that one", "that session"]);
const SEE_ONE_NOISE = /^(?:what|why|how|that|this|me|us|any|anything|something|nothing|everything|all|where|when|who|whether|if|one|some|more|which)\b|\b(?:with|about|that|this|of|in|on|for|to|from)\b/iu;
const WHY = /\b(?:why|how come)\b/iu;
const NO_TAG = new RegExp([
  "\\bno (?:voice )?tags?\\b",
  "\\b(?:without|missing) (?:a |the |its |any )?(?:voice )?tags?\\b",
  "\\b(?:doesn't|does not|didn't|did not|hasn't|has not|don't|do not|never) (?:have|get|got|gotten|receive|received) (?:a |its |any |the )?(?:voice )?tags?\\b",
  "\\b(?:isn't|is not|wasn't|was not) (?:there )?(?:a |any )?(?:voice )?tag\\b",
  "\\btags? (?:is |are |was |were )?(?:missing|gone|absent)\\b",
  "\\b(?:not tagged|untagged)\\b",
].join("|"), "iu");
const TAG_TARGET = /\b(?:on|for|with)\s+(?:the\s+|my\s+|that\s+|this\s+)?([\p{L}][\p{L}\p{N}' -]{0,40}?)(?:\s+(?:session|thread))?[?.!]*$/iu;
const TAG_SUBJECT = /\b(?:does|did|doesn't|didn't|has|hasn't)\s+(?:the\s+)?([\p{L}][\p{L}\p{N}' -]{0,40}?)(?:\s+(?:session|thread))?\s+(?:not\s+)?(?:have|got|get|getting)\b/iu;
const TAG_TARGET_NOISE = /^(?:one|it|that|this|them|some|any|an?|the|my|new|thread|session|sessions|threads|i|we|you)\b|\b(?:thread|session|sessions|threads)\b/iu;

function whyNoTag(text) {
  const why = WHY.exec(text);
  if (!why || !NO_TAG.test(text.slice(why.index))) return null;
  const question = text.slice(why.index);
  const target = TAG_TARGET.exec(question) || TAG_SUBJECT.exec(question);
  const name = target?.[1].trim();
  return { kind: "why-no-tag", target: name && !TAG_TARGET_NOISE.test(name) ? name : null };
}

function seeOne(text) {
  for (const pattern of SEE_ONE) {
    const match = pattern.exec(text);
    if (!match) continue;
    const target = match[1].trim();
    if (SEE_ONE_PRONOUNS.has(target.toLowerCase())) return { kind: "see-one", target };
    if (SEE_ONE_NOISE.test(target) || target.split(/\s+/).length > 4) return null;
    return { kind: "see-one", target };
  }
  return null;
}

/** A turn addressed to a session (tell/ask/direct name) is never a Jester question. */
function addressed(text, knownTags) {
  if (TELL.test(text)) return true;
  const direct = DIRECT.exec(text);
  if (!direct) return false;
  const name = direct[1].toLowerCase();
  // Without a tag list, a discourse word before a comma ("Yeah, ...") is not a session.
  return knownTags ? knownTags.has(name) : !FILLER.test(`${name} `);
}
const WHEN = new RegExp(`^(?:when|after)\\s+${NAME}\\s+(?:finishes|is done|completes)[,;:]?\\s+(?:tell|ask)\\s+${NAME}\\s+(?:to|that)\\s+(.+)$`, "iu");
const WHEN_RESULTS = /^(?:when|after)\s+(.+?)\s+(?:finish|finishes|are done|is done|complete|completes)[,;:]?\s+(?:tell|show|give)\s+me\s+(?:what\s+(?:i|we)\s+can\s+test|(?:the\s+)?test(?:ing)?\s+(?:ideas|steps|suggestions))[?.!]*$/iu;
const WHEN_BOTH = new RegExp(`^(?:when|after)\\s+both\\s+(?:finish|are done|complete)[,;:]?\\s+(?:tell|ask)\\s+${NAME}\\s+(?:to|that)\\s+(.+)$`, "iu");
const ALL_RUNNING = /^(?:all\s+(?:(?:of\s+)?(?:the\s+)?|my\s+)?(?:currently\s+)?(?:running|active|working)\s+sessions?|everyone\s+working)$/iu;

/** Create, follow-on and thread-search commands keep their task words, even ones that sound like a question. */
function isCommand(text) {
  return [CREATE, CREATE_EMPTY, HISTORY, WHEN, WHEN_BOTH, WHEN_RESULTS].some(pattern => pattern.test(text));
}

function resultTargets(raw) {
  const names = raw.trim().replace(/^both\s+/iu, "");
  if (ALL_RUNNING.test(names)) return { selection: "running", targets: [] };
  const targets = names.split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu).map(name => name.trim());
  if (!targets.length || targets.some(name => !/^[\p{L}][\p{L}\p{N}'-]*$/u.test(name))) return null;
  return { selection: "named", targets };
}

/** Contextual read questions after a named session was just discussed. */
export function isSessionReadFollowUp(raw) {
  const text = String(raw || "").trim().replace(WAKE, "").trim();
  if (/^(?:why|tell me more|what should i do next)[?.!]*$/iu.test(text)) return true;
  return /^(?:what|how|why|is it|did it|tell me|explain|help me|should i)\b/i.test(text) &&
    /\b(?:this project|that project|the project|its work|its result|it finish|it do|it working|it blocked|next step|next decision|that result)\b/i.test(text);
}

/** Pure first pass. No model text or transcript event can execute an action here. */
export function parseOwnerIntent(raw, { knownTags = null } = {}) {
  const text = String(raw || "").trim().replace(WAKE, "").trim();
  if (/\b(?:but|wait|hold on)[,;\s]+(?:don['’]?t|do\s+not)\s+(?:send|post|give|dispatch)\b/iu.test(text) ||
      /\b(?:hold off|wait before (?:sending|posting))\b/iu.test(text)) {
    return { kind: "clarify", reason: "hold" };
  }
  if (/^who(?:'s| is)\s+(?:running|working|active)[?.!]*$/i.test(text)) return { kind: "status-all" };
  if (/^(?:update me on (?:my )?sessions|give me a (?:session|sessions) update|what(?:'s| is) happening with (?:my )?sessions)[?.!]*$/i.test(text)) {
    return { kind: "status-all" };
  }
  // Read-only session questions answered from the EBI snapshot, never by a model.
  if (!addressed(text, knownTags) && !isCommand(text)) {
    const question = text.replace(FILLER, "").trim();
    if (LIST_OPEN.some(pattern => pattern.test(question))) return { kind: "list-open" };
    const noTag = whyNoTag(question);
    if (noTag) return noTag;
    const seen = seeOne(question);
    if (seen) return seen;
  }
  const status = statusOne.exec(text) || statusNatural.exec(text);
  if (status) return { kind: "status-one", target: status[1] };
  if (statusLast.test(text)) return { kind: "status-last", target: "it" };
  const discussion = discussSession.exec(text);
  if (discussion) return { kind: "session-discuss", target: discussion[1] };
  const naturalDiscussion = discussNatural.exec(text);
  if (naturalDiscussion && (!knownTags || knownTags.has(naturalDiscussion[1].toLowerCase()))) {
    return { kind: "session-discuss", target: naturalDiscussion[1] };
  }
  const stop = STOP.exec(text);
  if (stop) return { kind: "stop", target: stop[1] };
  const close = CLOSE.exec(text);
  if (close) return { kind: "close", target: close[1] };
  const runtime = RUNTIME.exec(text);
  if (runtime) return { kind: "runtime", target: runtime[1], runtime: runtime[2], model: runtime[3] || null };
  const empty = CREATE_EMPTY.exec(text);
  if (empty) return { kind: "create", project: empty[1].trim(), runtime: empty[2] || null,
    model: empty[3] || null, instruction: null, empty: true };
  const create = CREATE.exec(text);
  if (create) return { kind: "create", project: create[1].trim(), runtime: create[2] || null,
    model: create[3] || null, instruction: create[4].trim() };
  const history = HISTORY.exec(text);
  if (history) return { kind: "history", query: history[1].trim().replace(/^(?:worked on|talked about|did)\s+/iu, "") };
  const bareHistory = HISTORY_BARE.exec(text);
  if (bareHistory) return { kind: "history", query: bareHistory[1].trim() };
  // Broader read-only questions may use ordinary wording. A current tag is
  // evidence of a target, never authorization for a session write.
  if (knownTags && /^(?:what|how|why|tell me|explain|help me understand|give me (?:an? )?(?:update|summary))/iu.test(text)) {
    const mentions = [...knownTags].filter(tag =>
      new RegExp(`(?<![\\p{L}\\p{N}])${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text));
    if (mentions.length === 1) return { kind: "session-discuss", target: mentions[0] };
  }
  const when = WHEN.exec(text);
  if (when) return { kind: "dependency", source: when[1], target: when[2], instruction: when[3].trim() };
  const both = WHEN_BOTH.exec(text);
  if (both) return { kind: "dependency-group", target: both[1], instruction: both[2].trim() };
  const results = WHEN_RESULTS.exec(text);
  if (results) {
    const parsed = resultTargets(results[1]);
    return parsed ? { kind: "result-watch", ...parsed } :
      { kind: "clarify", reason: "result-targets" };
  }

  if (/^(?:tell|ask|message)\s+me\b/iu.test(text)) return null;
  const explicit = TELL.exec(text);
  const direct = explicit ? null : DIRECT.exec(text);
  // The voice loop supplies current tags. A comma after an ordinary first
  // word ("Actually, ...") must stay in conversation, not become a command.
  if (direct && knownTags && !knownTags.has(direct[1].toLowerCase())) return null;
  const first = explicit || direct;
  if (!first) return null;
  let target = first[1];
  let body = text.slice(first[0].length).trim();
  const correction = CORRECTION.exec(body);
  if (correction) {
    target = correction[1];
    body = body.slice(correction[0].length).trim();
  }
  const targetCorrection = TARGET_CORRECTION.exec(body);
  if (targetCorrection) {
    target = targetCorrection[1];
    body = body.slice(targetCorrection.index + targetCorrection[0].length).trim();
  }
  const taskCorrection = /(?:[,;:—–-]\s*|\b)(?:actually|no,?\s*|rather|instead)\s+/iu.exec(body);
  if (taskCorrection) {
    const final = body.slice(taskCorrection.index + taskCorrection[0].length).trim();
    // A clear replacement task wins. A fragment like "in the other folder"
    // still needs Drew to finish the instruction before any session receives it.
    if (!/^(?:(?:just\s+)?(?:test|check|run|fix|build|write|add|remove|review|deploy|ship|create|open|close|start|stop|tell|send|make|update)\b|we\s+need\s+to\b)/iu.test(final)) {
      return { kind: "clarify", reason: "task-correction", target };
    }
    body = final;
  }
  if (!body) return { kind: "clarify", reason: "missing-task", target };
  // Keep Drew's task words intact. Corrections inside the task need a later
  // structured pass; they never authorize an early action from a partial turn.
  return { kind: "message", target, instruction: body };
}
