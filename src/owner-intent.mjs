const WAKE = /^(?:(?:hey|hi|hello|okay|ok)\s*[,!.]?\s+)?jester\b[\s,!.:;—–-]*/i;
const NAME = "([\\p{L}][\\p{L}\\p{N}'-]*)";
const statusOne = new RegExp(`^(?:what(?:'s| is) |what is )${NAME} (?:doing|working on|up to)[?.!]*$`, "iu");
const CORRECTION = new RegExp(`^(?:actually|no|wait|rather)\\s+${NAME}\\s*[,;:—–-]*\\s*`, "iu");
const TELL = new RegExp(`^(?:and\\s+)?(?:tell|ask|message)\\s+${NAME}(?:\\s+to\\s+|\\s+that\\s+|[,;:—–-]\\s*|\\s+|$)`, "iu");
const DIRECT = new RegExp(`^(?:and\\s+)?${NAME}\\s*[,;:—–-]\\s*`, "iu");
const STOP = new RegExp(`^(?:stop|interrupt)(?:\\s+the)?(?:\\s+current)?(?:\\s+turn\\s+(?:in|for))?\\s+${NAME}[?.!]*$`, "iu");

/** Pure first pass. No model text or transcript event can execute an action here. */
export function parseOwnerIntent(raw) {
  const text = String(raw || "").trim().replace(WAKE, "").trim();
  if (/^who(?:'s| is)\s+(?:running|working|active)[?.!]*$/i.test(text)) return { kind: "status-all" };
  const status = statusOne.exec(text);
  if (status) return { kind: "status-one", target: status[1] };
  const stop = STOP.exec(text);
  if (stop) return { kind: "stop", target: stop[1] };

  const first = TELL.exec(text) || DIRECT.exec(text);
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
