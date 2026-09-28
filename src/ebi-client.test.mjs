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
