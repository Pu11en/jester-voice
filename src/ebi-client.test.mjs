import assert from "node:assert/strict";
import test from "node:test";
import { EbiClient } from "./ebi-client.mjs";

const session = (id, tag, extra = {}) => ({ thread_id: id, tag, name: tag, state: "running", ...extra });

test("resolves Frankie to the current exact string ID without losing snowflake bits", async () => {
  const calls = [];
  const client = new EbiClient({ secret: "local-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ sessions: [
      session("1553899450227757156", "franky"), session("1553779983158349925", "zoro"),
    ] }) };
  } });
  const result = await client.resolveTag("Frankie!");
  assert.equal(result.kind, "found");
  assert.equal(result.session.threadId, "1553899450227757156");
  assert.match(calls[0].url, /\/api\/jester\/sessions/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer local-secret");
});

test("unknown, duplicate, closed, and numeric IDs cannot become an action target", async () => {
  let rows = [session("1553899450227757156", "franky")];
  const client = new EbiClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ sessions: rows }) }) });
  assert.equal((await client.resolveTag("nami")).kind, "unknown");
  rows = [session("1553899450227757156", "franky"), session("1553779983158349925", "franky")];
  assert.equal((await client.resolveTag("Frankie")).kind, "ambiguous");
  rows = [session("1553899450227757156", "franky", { closed: true })];
  assert.equal((await client.resolveTag("Frankie")).kind, "unknown");
  rows = [session(1553899450227757156, "franky")];
  await assert.rejects(client.resolveTag("Frankie"), /invalid or duplicate thread ID/);
});

test("snapshot shares one request in flight and reads again for a later action", async () => {
  let calls = 0;
  const client = new EbiClient({ fetchImpl: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ sessions: [session("1553899450227757156", "franky")] }) };
  } });
  await Promise.all([client.snapshot(), client.snapshot()]);
  assert.equal(calls, 1);
  await client.snapshot();
  assert.equal(calls, 2);
  assert.throws(() => new EbiClient({ baseUrl: "https://example.com" }), /local API/);
});

test("a lost POST response reconciles the same request ID without posting twice", async () => {
  const calls = [];
  const client = new EbiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || "GET" });
    if (options.method === "POST") throw new Error("response lost");
    return { ok: true, json: async () => ({ status: "posted", request_id: "jester-test-1" }) };
  } });
  const result = await client.sendSpoken({ threadId: "1553899450227757156",
    speakerId: "488763953397235712", text: "check login", requestId: "jester-test-1" });
  assert.equal(result.status, "posted");
  assert.deepEqual(calls.map(c => c.method), ["POST", "GET"]);
});

test("unknown delivery never retries a spoken POST", async () => {
  let posts = 0;
  const client = new EbiClient({ fetchImpl: async (_url, options) => {
    if (options.method === "POST") posts++;
    throw new Error("offline");
  } });
  await assert.rejects(client.sendSpoken({ threadId: "1553899450227757156",
    speakerId: "488763953397235712", text: "check login", requestId: "jester-test-2" }),
  /Delivery uncertain/);
  assert.equal(posts, 1);
});

test("a lost spawn response resolves its correlation without creating another thread", async () => {
  const calls = [];
  const client = new EbiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (options.method === "POST") throw new Error("response lost");
    return { ok: true, json: async () => ({ thread_id: "1554146845415055445" }) };
  } });
  const result = await client.spawnSession({ projectPath: "/projects/jester-voice",
    instruction: "check the tests", ownerId: "488763953397235712", correlationId: "jester-spawn-1" });
  assert.equal(result.thread_id, "1554146845415055445");
  assert.deepEqual(calls.map(c => c.method), ["POST", "GET"]);
  assert.match(calls[1].url, /jester-spawn-1$/);
  assert.equal(JSON.parse(calls[0].body).model, undefined);
});

test("explicit empty spawn sends no prompt and does not start a worker", async () => {
  let payload;
  const client = new EbiClient({ fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ thread_id: "1554146845415055445",
      status: "spawned", voice_label: "jinbe" }) };
  } });
  const result = await client.spawnSession({ projectPath: "/projects/jobs", empty: true,
    threadName: "Jobs", ownerId: "488763953397235712" });
  assert.equal(result.thread_id, "1554146845415055445");
  assert.equal(payload.prompt, undefined);
  assert.equal(payload.auto_start, false);
  assert.equal(payload.empty, true);
  assert.equal(payload.thread_name, "Jobs");
});

test("history accepts only exact string IDs, never rounded JSON numbers", async () => {
  const client = new EbiClient({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ results: [{ thread_id: 1554145503506333736, thread_id_str: "1554145503506333736",
      thread_name: "Login audit", deep_link: "https://discord.com/channels/guild/thread" }] }) }) });
  assert.equal((await client.searchSessions("login"))[0].threadId, "1554145503506333736");
  const unsafe = new EbiClient({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ results: [{ thread_id: 1554145503506333736 }] }) }) });
  await assert.rejects(unsafe.searchSessions("login"), /unsafe thread ID/);
});

test("reads bounded thread replies through the exact ID without trusting numeric JSON IDs", async () => {
  const seen = [];
  const client = new EbiClient({ fetchImpl: async url => {
    seen.push(url);
    return { ok: true, json: async () => ({ thread_id: 1554145503506333736,
      messages: [{ is_bot: true, content: "- Open the page",
        created_at: "2026-09-28T12:00:00Z", jump_url: "https://discord.com/channels/1/2/3" }] }) };
  } });
  const messages = await client.threadMessages("1554145503506333736", 20);
  assert.equal(messages[0].content, "- Open the page");
  assert.match(seen[0], /\/api\/threads\/1554145503506333736\/messages\?limit=20$/);
  await assert.rejects(client.threadMessages("1554145503506333700", 101), /Invalid thread message request/);
});

test("snapshot accepts the coming visibility fields and today's shape alike", async () => {
  let body = { sessions: [session("1553899450227757156", "franky")] };
  const client = new EbiClient({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
  let rows = await client.snapshot();
  assert.equal(rows[0].closed, false, "a missing closed field is an open row");
  assert.equal(rows[0].visible, null);
  assert.deepEqual(client.lastSnapshotMeta, { openCount: null, discordActiveThreads: null });
  body = { sessions: [session("1553899450227757156", "franky", { visible: false, closed: false }),
    session("1553779983158349925", "zoro", { visible: true })], open_count: 24, discord_active_threads: 2 };
  rows = await client.snapshot();
  assert.deepEqual(rows.map(row => row.visible), [false, true]);
  assert.deepEqual(client.lastSnapshotMeta, { openCount: 24, discordActiveThreads: 2 });
  assert.equal((await client.resolveTag("franky")).kind, "found", "visibility never hides a target");
});
