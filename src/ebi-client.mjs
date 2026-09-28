const THREAD_ID = /^\d{17,20}$/;
const ALIASES = new Map([["frankie", "franky"]]);

export function normalizeTag(value) {
  return String(value || "").trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export class EbiClient {
  constructor({ baseUrl = "http://127.0.0.1:9876", secret = "", fetchImpl = fetch,
    timeoutMs = 5_000 } = {}) {
    const url = new URL(baseUrl);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("EBI control must use the local API");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pendingSnapshot = null;
  }

  async #request(path, options = {}) {
    const headers = { Accept: "application/json", ...options.headers };
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options, headers, signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`EBI API returned ${response.status}`);
    return response.json();
  }

  async snapshot() {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    this.pendingSnapshot = (async () => {
      const body = await this.#request("/api/jester/sessions?limit=100");
      if (!Array.isArray(body.sessions)) throw new Error("EBI session snapshot is invalid");
      const ids = new Set();
      return body.sessions.map((raw) => {
        // JSON numbers lose bits from Discord snowflakes. Never guess a target.
        if (typeof raw.thread_id !== "string" || !THREAD_ID.test(raw.thread_id) || ids.has(raw.thread_id)) {
          throw new Error("EBI session snapshot has an invalid or duplicate thread ID");
        }
        ids.add(raw.thread_id);
        return {
          threadId: raw.thread_id,
          tag: normalizeTag(raw.tag),
          aliases: Array.isArray(raw.aliases) ? raw.aliases.map(normalizeTag) : [],
          name: String(raw.name || ""),
          project: String(raw.project || ""),
          state: String(raw.state || "history"),
          closed: raw.closed === true,
        };
      });
    })();
    try { return await this.pendingSnapshot; }
    finally { this.pendingSnapshot = null; }
  }

  async resolveTag(spoken) {
    const value = normalizeTag(spoken);
    if (!value) return { kind: "unknown" };
    const canonical = ALIASES.get(value) || value;
    const sessions = await this.snapshot();
    const matches = sessions.filter(session => !session.closed &&
      (session.tag === value || session.tag === canonical || session.aliases.includes(value)));
    if (!matches.length) return { kind: "unknown" };
    if (matches.length !== 1) return { kind: "ambiguous", matches };
    return { kind: "found", session: matches[0] };
  }
}
