const WAKE = /^(?:(?:hey|hi|hello|yo)\s+)?jester\b[\s,!.:;-]*/i;
const START = /^(?:open|create|start|make)(?: me)?(?: a)?(?: new)? session (?:in|for) (.+?)[.!?]*$/iu;
const SPOKEN_START = /^(?:uh\s+)?(?:yeah[,\s]+)?open(?: of)? a thread in (?:the )?(.+?) folder[.!?]*$/iu;
const TOPIC = /^(?:it['’]?s|it is) for (.+?)(?:[.!?]|$)/iu;
const SPOKEN_TOPIC = /^(?:and\s+)?the session is (?:gonna|going to) be about (.+?)(?:[.!?]|$)/iu;
const TASK = /^(?:have it|tell it to|ask it to)\s+(.+)$/iu;
const TASK_VERB = /^(?:just\s+)?(?:review|check|test|write|make|build|fix|add|remove|update|find|research|draft|create|start)\b/iu;

/** Hold a session request across owner turns; incomplete speech has no effect. */
export class CreateDraft {
  constructor() { this.reset(); }

  reset() { this.pending = null; }

  consume(raw) {
    const text = String(raw || "").trim().replace(WAKE, "").trim();
    const started = START.exec(text) || SPOKEN_START.exec(text);
    if (started) {
      this.pending = { project: started[1].trim(), topic: null };
      return { handled: true, reply: "What should that session work on?" };
    }
    if (!this.pending) return { handled: false };
    const topic = TOPIC.exec(text) || SPOKEN_TOPIC.exec(text);
    if (topic && /\b(?:have something|something to add|i'll give|will give)\b/iu.test(text)) {
      this.pending.topic = topic[1].trim();
      return { handled: true, reply: "Go ahead." };
    }
    const task = TASK.exec(text);
    if (!task) return { handled: false };
    let instruction = task[1].trim();
    const correction = /\bactually\s*[,;:]?\s*/giu;
    const matches = [...instruction.matchAll(correction)];
    if (matches.length) instruction = instruction.slice(matches.at(-1).index + matches.at(-1)[0].length).trim();
    instruction = instruction.replace(/^just\s+/iu, "");
    if (!TASK_VERB.test(instruction)) return { handled: true, reply: "Please finish the task before I create it." };
    if (this.pending.topic && /\bthe profile\b/iu.test(instruction)) {
      instruction = instruction.replace(/\bthe profile\b/iu, `the ${this.pending.topic} profile`);
    }
    const result = { handled: true, project: this.pending.project, instruction };
    this.reset();
    return result;
  }
}
