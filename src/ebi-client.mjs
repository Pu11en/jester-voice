import { randomUUID } from "node:crypto";

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
    const { timeoutMs = this.timeoutMs, ...fetchOptions } = options;
    const headers = { Accept: "application/json", ...fetchOptions.headers };
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...fetchOptions, headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`EBI API returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
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
          currentTask: String(raw.current_task || ""),
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

  async sendSpoken({ threadId, text, speakerId, mode = "queue", requestId = randomUUID() }) {
    if (!THREAD_ID.test(threadId) || !THREAD_ID.test(String(speakerId))) throw new Error("Invalid owner or target ID");
    if (!text?.trim() || text.length > 24_000) throw new Error("Spoken assignment is empty or too long");
    const path = `/api/threads/${threadId}/spoken`;
    const payload = { text, speaker_id: String(speakerId), mode, source: "voice", request_id: requestId };
    try {
      await this.#request(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch (error) {
      // A timeout may happen after EBI accepted the request. Never POST again.
      try { return await this.spokenReceipt(threadId, requestId); }
      catch { throw new Error(`Delivery uncertain for request ${requestId}`, { cause: error }); }
    }
    return this.spokenReceipt(threadId, requestId);
  }

  async spokenReceipt(threadId, requestId) {
    if (!THREAD_ID.test(threadId) || !/^[\w-]{8,100}$/.test(requestId)) throw new Error("Invalid receipt identity");
    return this.#request(`/api/threads/${threadId}/spoken/${encodeURIComponent(requestId)}`);
  }

  async stopTurn(threadId, speakerId) {
    if (!THREAD_ID.test(threadId) || !THREAD_ID.test(String(speakerId))) throw new Error("Invalid owner or target ID");
    return this.#request(`/api/threads/${threadId}/stop-turn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker_id: String(speakerId) }),
    });
  }

  async resolveProject(name) {
    if (!name?.trim() || name.length > 200) throw new Error("Invalid project name");
    return this.#request("/api/projects/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: name.trim() }),
    });
  }

  async spawnSession({ projectPath, instruction, ownerId, backend = "codex", model = null,
    correlationId = randomUUID() }) {
    if (!projectPath?.startsWith("/") || !instruction?.trim() || !THREAD_ID.test(String(ownerId))) {
      throw new Error("Invalid session request");
    }
    const payload = { prompt: instruction.trim(), working_dir: projectPath, user_id: String(ownerId),
      backend, auto_start: true, correlation_id: correlationId };
    if (model) payload.model = model;
    try {
      const result = await this.#request("/api/spawn", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!THREAD_ID.test(result.thread_id)) throw new Error("Spawn returned an invalid thread ID");
      return result;
    } catch (error) {
      // The thread may exist even when the answer was lost. Query its durable
      // correlation, never repeat the spawn request with a new identity.
      try {
        const result = await this.#request(`/api/correlations/${encodeURIComponent(correlationId)}`);
        if (!THREAD_ID.test(result.thread_id)) throw new Error("Invalid correlated thread ID");
        return { status: "existing", ...result };
      } catch { throw new Error(`Session creation uncertain for ${correlationId}`, { cause: error }); }
    }
  }

  async setRuntime(threadId, { backend, model }) {
    if (!THREAD_ID.test(threadId) || !backend) throw new Error("Invalid runtime target");
    return this.#request(`/api/threads/${threadId}/runtime`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend, model }),
    });
  }

  async closeSession(threadId, ownerId) {
    if (!THREAD_ID.test(threadId) || !THREAD_ID.test(String(ownerId))) throw new Error("Invalid close target");
    return this.#request(`/api/threads/${threadId}/close`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: String(ownerId) }),
    });
  }

  async turnUpdates({ since, after = "", limit = 100 }) {
    if (typeof since !== "string" || Number.isNaN(Date.parse(since))) throw new Error("Invalid turn cursor");
    const query = new URLSearchParams({ since, after, limit: String(limit) });
    const result = await this.#request(`/api/jester/turns?${query}`);
    if (!Array.isArray(result.turns) || typeof result.has_more !== "boolean") {
      throw new Error("Invalid turn journal response");
    }
    for (const turn of result.turns) {
      if (!THREAD_ID.test(turn.thread_id) || typeof turn.turn_key !== "string" ||
          typeof turn.updated_at !== "string") throw new Error("Invalid turn journal entry");
    }
    return result;
  }

  async threadMessages(threadId, limit = 30) {
    if (!THREAD_ID.test(threadId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid thread message request");
    }
    const result = await this.#request(`/api/threads/${threadId}/messages?limit=${limit}`,
      { timeoutMs: 10_000 });
    if (!Array.isArray(result.messages)) throw new Error("Invalid thread messages response");
    return result.messages.map(message => ({
      is_bot: message.is_bot === true,
      content: String(message.content || ""),
      created_at: String(message.created_at || ""),
      jump_url: typeof message.jump_url === "string" ? message.jump_url : null,
    }));
  }

  async searchSessions(query) {
    if (!query?.trim() || query.length > 200) throw new Error("Invalid history query");
    const params = new URLSearchParams({ q: query.trim(), origin: "discord", limit: "10", body: "1" });
    const result = await this.#request(`/api/search?${params}`, { timeoutMs: 10_000 });
    if (!Array.isArray(result.results)) throw new Error("Invalid history results");
    return result.results.map(row => {
      if (typeof row.thread_id_str !== "string" || !THREAD_ID.test(row.thread_id_str)) {
        throw new Error("History returned an unsafe thread ID");
      }
      return { threadId: row.thread_id_str, name: String(row.thread_name || ""),
        project: String(row.working_dir || ""), lastUsed: String(row.last_used_at || ""),
        snippet: String(row.snippet || ""), link: String(row.deep_link || "") };
    });
  }
}
