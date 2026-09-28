const WAKE = /^(?:(?:hey|hi|hello|okay|ok)\s*[,!.]?\s+)?jester\b[\s,!.:;—–-]*/i;
const NAME = "([\\p{L}][\\p{L}\\p{N}'-]*)";
const statusOne = new RegExp(`^(?:what(?:'s| is) |what is )${NAME} (?:doing|working on|up to)[?.!]*$`, "iu");
const CORRECTION = new RegExp(`^(?:actually|no|wait|rather)\\s+${NAME}\\s*[,;:—–-]*\\s*`, "iu");
const TELL = new RegExp(`^(?:and\\s+)?(?:tell|ask|message)\\s+${NAME}(?:\\s+to\\s+|\\s+that\\s+|[,;:—–-]\\s*|\\s+|$)`, "iu");
const DIRECT = new RegExp(`^(?:and\\s+)?${NAME}\\s*[,;:!?—–-]\\s*`, "iu");
const STOP = new RegExp(`^(?:stop|interrupt)(?:\\s+the)?(?:\\s+current)?(?:\\s+turn\\s+(?:in|for))?\\s+${NAME}[?.!]*$`, "iu");
const CLOSE = new RegExp(`^(?:close|archive|end)(?:\\s+the)?(?:\\s+session)?\\s+${NAME}[?.!]*$`, "iu");
const RUNTIME = new RegExp(`^(?:switch|set|move)\\s+${NAME}\\s+(?:to|onto)\\s+(codex|claude|sonnet|deepseek|dsh)(?:\\s+(sonnet|opus|haiku|auto))?[?.!]*$`, "iu");
const CREATE = /^(?:start|create|open|make)(?: me)?(?: a)?(?: new)? session (?:in|for) (.+?)(?: (?:using|with) (codex|claude|sonnet|deepseek|dsh)(?: (sonnet|opus|haiku|auto))?)? (?:to|and (?:ask|tell) (?:it|them) to) (.+)$/iu;
const HISTORY = /^(?:find|look up|search for)(?: the)? (?:session|thread)(?: where we| that| about| for)? (.+?)[?.!]*$/iu;
const WHEN = new RegExp(`^(?:when|after)\\s+${NAME}\\s+(?:finishes|is done|completes)[,;:]?\\s+(?:tell|ask)\\s+${NAME}\\s+(?:to|that)\\s+(.+)$`, "iu");
const WHEN_RESULTS = /^(?:when|after)\s+(.+?)\s+(?:finish|finishes|are done|is done|complete|completes)[,;:]?\s+(?:tell|show|give)\s+me\s+(?:what\s+(?:i|we)\s+can\s+test|(?:the\s+)?test(?:ing)?\s+(?:ideas|steps|suggestions))[?.!]*$/iu;
const ALL_RUNNING = /^(?:all\s+(?:(?:of\s+)?(?:the\s+)?|my\s+)?(?:currently\s+)?(?:running|active|working)\s+sessions?|everyone\s+working)$/iu;

function resultTargets(raw) {
  const names = raw.trim().replace(/^both\s+/iu, "");
  if (ALL_RUNNING.test(names)) return { selection: "running", targets: [] };
  const targets = names.split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu).map(name => name.trim());
  if (!targets.length || targets.some(name => !/^[\p{L}][\p{L}\p{N}'-]*$/u.test(name))) return null;
  return { selection: "named", targets };
}

/** Pure first pass. No model text or transcript event can execute an action here. */
export function parseOwnerIntent(raw, { knownTags = null } = {}) {
  const text = String(raw || "").trim().replace(WAKE, "").trim();
  if (/^who(?:'s| is)\s+(?:running|working|active)[?.!]*$/i.test(text)) return { kind: "status-all" };
  if (/^(?:update me on (?:my )?sessions|give me a (?:session|sessions) update|what(?:'s| is) happening with (?:my )?sessions)[?.!]*$/i.test(text)) {
    return { kind: "status-all" };
  }
  const status = statusOne.exec(text);
  if (status) return { kind: "status-one", target: status[1] };
  const stop = STOP.exec(text);
  if (stop) return { kind: "stop", target: stop[1] };
  const close = CLOSE.exec(text);
  if (close) return { kind: "close", target: close[1] };
  const runtime = RUNTIME.exec(text);
  if (runtime) return { kind: "runtime", target: runtime[1], runtime: runtime[2], model: runtime[3] || null };
  const create = CREATE.exec(text);
  if (create) return { kind: "create", project: create[1].trim(), runtime: create[2] || null,
    model: create[3] || null, instruction: create[4].trim() };
  const history = HISTORY.exec(text);
  if (history) return { kind: "history", query: history[1].trim().replace(/^(?:worked on|talked about|did)\s+/iu, "") };
  const when = WHEN.exec(text);
  if (when) return { kind: "dependency", source: when[1], target: when[2], instruction: when[3].trim() };
  const results = WHEN_RESULTS.exec(text);
  if (results) {
    const parsed = resultTargets(results[1]);
    return parsed ? { kind: "result-watch", ...parsed } :
      { kind: "clarify", reason: "result-targets" };
  }

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
