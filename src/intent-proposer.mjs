import { Brain } from "./brain.mjs";

const WAKE = /^(?:(?:hey|hi|hello|okay|ok|yo)\s+)?jester\b[\s,!.:;—–-]*/iu;
const WORK_START = /^(?:please\s+)?(?:could you|can you|would you|i (?:need|want|would like)(?: you)? to|we (?:need|want) to|let's|have|ask|tell|message|send|give|put|start|open|create|make)\b/iu;
export const PROPOSER_INSTRUCTIONS = `You only classify an owner's completed voice request. Return one JSON object and nothing else.
Schema: {"kind":"message"|"create"|"none","target":"...","project":"...","instruction":"..."}.
Use message only for a clear instruction to send work to a named session. Use create only for a clear instruction to create a session with a first task. Use none for questions, discussion, incomplete speech, corrections that are unfinished, and anything asking to hold a send.
Target/project must appear in the utterance. The instruction must be an exact contiguous substring of the utterance, with no invented or rewritten words. Include every constraint in the final instruction span. The program verifies all fields and performs any action; you cannot perform actions.`;

const hasWord = (text, word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** The span must be non-empty and start at a word boundary: no clipped first word. */
function endsWithWholeWords(utterance, span) {
  if (!/[\p{L}\p{N}]/u.test(span) || !utterance.endsWith(span)) return false;
  const before = utterance.slice(0, utterance.length - span.length);
  return !before || !/[\p{L}\p{N}]$/u.test(before) || !/^[\p{L}\p{N}]/u.test(span);
}

/**
 * The first complete JSON object in a model reply: a bare object, one inside markdown code
 * fences, or one with a short sentence around it. Returns undefined when none parses.
 */
export function parseProposalReply(output) {
  const text = String(output || "");
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return undefined;
}

export class IntentProposer {
  constructor({ brain = new Brain({ baseInstructions: PROPOSER_INSTRUCTIONS, effort: "low" }) } = {}) {
    this.brain = brain;
  }

  likelyWork(raw, tags = []) {
    const text = String(raw || "").trim().replace(WAKE, "").trim();
    if (!WORK_START.test(text) || /^(?:what|how|why)\b/iu.test(text)) return false;
    return tags.some(tag => hasWord(text, tag)) || /\b(?:session|thread)\b/iu.test(text);
  }

  async propose(raw, tags = []) {
    const text = String(raw || "").trim();
    if (!this.likelyWork(text, tags)) return null;
    if (/\b(?:don['’]?t|do not)\s+(?:send|post|dispatch)\b/iu.test(text)) {
      return { kind: "clarify", reason: "hold" };
    }
    let output = "";
    try {
      for await (const part of this.brain.ask(JSON.stringify({ utterance: text, currentTags: tags }),
        { whole: true })) output += part;
    } catch {
      return { kind: "clarify", reason: "proposal-unavailable" };
    }
    const proposal = parseProposalReply(output);
    if (proposal === undefined) return { kind: "clarify", reason: "proposal-invalid" };
    if (proposal?.kind === "none") return null;
    const utteranceEnd = text.trim().replace(/[?.!]+$/u, "").toLocaleLowerCase();
    const instructionEnd = String(proposal?.instruction || "").trim()
      .replace(/[?.!]+$/u, "").toLocaleLowerCase();
    if (!["message", "create"].includes(proposal?.kind) ||
        typeof proposal.instruction !== "string" || !proposal.instruction.trim() ||
        !endsWithWholeWords(utteranceEnd, instructionEnd)) {
      return { kind: "clarify", reason: "proposal-invalid" };
    }
    if (proposal.kind === "message") {
      const proposedTarget = String(proposal.target || "").trim();
      const matches = tags.filter(tag => hasWord(proposedTarget, tag) && hasWord(text, tag));
      if (matches.length !== 1) return { kind: "clarify", reason: "proposal-target" };
      return { kind: "message", target: matches[0], instruction: proposal.instruction.trim() };
    }
    const project = String(proposal.project || "").trim();
    if (!project || !hasWord(text, project)) return { kind: "clarify", reason: "proposal-project" };
    return { kind: "create", project, instruction: proposal.instruction.trim(),
      runtime: null, model: null };
  }

  async close() { await this.brain.close(); }
  async interrupt() { await this.brain.interrupt(); }
}
