import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { Presence } from "./presence.mjs";

function setup({ channelId = null, transcript = null, privacyFile = join(tmpdir(), `jester-privacy-${randomUUID()}.json`) } = {}) {
  const client = new EventEmitter();
  const member = { voice: { channelId } };
  client.guilds = { cache: new Map([["guild", { members: { cache: new Map([["owner", member]]) } }]]) };
  const calls = { login: 0, connect: 0, disconnect: 0, prewarm: 0, paused: [] };
  const voice = {
    async login() { calls.login++; },
    async connect() { calls.connect++; },
    disconnect() { calls.disconnect++; },
    setCapturePaused(paused) { calls.paused.push(paused); },
  };
  const brain = { async prewarm() { calls.prewarm++; } };
  const config = { guildId: "guild", ownerId: "owner", voiceChannelId: "room", transcriptChannelId: "text" };
  return { client, member, calls, presence: new Presence({ client, voice, brain, config, transcript,
    privacyFile, logger: { warn() {} } }) };
}

test("room member can pause; only Drew resumes; paused state survives restart", async () => {
  const privacyFile = join(tmpdir(), `jester-privacy-${randomUUID()}.json`);
  const { client, calls, presence } = setup({ channelId: "room", privacyFile });
  const notices = [];
  const notice = { async edit(payload) { notices.push(payload); return this; } };
  client.channels = { cache: new Map([["text", { async send(payload) { notices.push(payload); return notice; } }]]) };
  const guild = client.guilds.cache.get("guild");
  guild.voiceStates = { cache: new Map([["guest", { channelId: "room" }]]) };
  const replies = [];
  const button = (id, user) => client.emit("interactionCreate", {
    isButton: () => true, customId: id, guildId: "guild", channelId: "text",
    user: { id: user }, reply: async (payload) => replies.push(payload.content),
  });
  try {
    await presence.start();
    button("jester:recording:pause", "guest");
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(presence.paused, true);
    assert.equal(JSON.parse(await readFile(privacyFile, "utf8")).paused, true);
    assert.ok(notices.some(payload => payload.content.includes("Recording is paused")));
    button("jester:recording:resume", "guest");
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(presence.paused, true);
    assert.match(replies.at(-1), /Only Drew/);
    presence.stop();
    const restarted = setup({ channelId: "room", privacyFile });
    await restarted.presence.start();
    assert.equal(restarted.presence.paused, true);
    assert.deepEqual(restarted.calls.paused, [true]);
    restarted.client.emit("interactionCreate", {
      isButton: () => true, customId: "jester:recording:resume", guildId: "guild", channelId: "text",
      user: { id: "owner" }, reply: async (payload) => replies.push(payload.content),
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(restarted.presence.paused, false);
    assert.equal(JSON.parse(await readFile(privacyFile, "utf8")).paused, false);
    restarted.presence.stop();
    assert.equal(calls.paused.at(-1), true);
  } finally { presence.stop(); await rm(privacyFile, { force: true }); }
});

test("joins and prewarms when owner arrives, leaves when owner leaves", async () => {
  const { client, calls, presence } = setup();
  await presence.start();
  assert.equal(calls.login, 1);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.connect, 1);
  assert.equal(calls.prewarm, 1);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.disconnect, 1);
  presence.stop();
});

test("joins on startup when Discord has the owner's voice state but no cached member", async () => {
  const { client, calls, presence } = setup();
  client.guilds.cache.get("guild").members.cache.clear();
  client.guilds.cache.get("guild").voiceStates = { cache: new Map([["owner", { channelId: "room" }]]) };
  await presence.start();
  assert.equal(calls.connect, 1);
  presence.stop();
});

test("addressed leave stays dismissed for this presence; unrelated words do nothing", async () => {
  const { calls, presence } = setup({ channelId: "room" });
  await presence.start();
  assert.equal(await presence.handleOwnerTurn("leave"), false);
  assert.equal(await presence.handleOwnerTurn("Jester, disconnect!"), true);
  assert.equal(calls.connect, 1);
  await presence.client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  assert.equal(calls.connect, 1);
  presence.client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  presence.client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.connect, 2);
  presence.stop();
});

test("text escape hatch is restricted to owner and transcript channel", async () => {
  const { client, calls, presence } = setup({ channelId: "room" });
  await presence.start();
  const msg = (author, channelId, content) => client.emit("messageCreate", {
    author: { id: author, bot: false }, guildId: "guild", channelId, content,
  });
  msg("other", "text", "!jester leave");
  msg("owner", "elsewhere", "!jester leave");
  assert.equal(calls.disconnect, 0);
  msg("owner", "text", "!jester leave");
  assert.equal(calls.disconnect, 1);
  msg("owner", "text", "!jester join");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.connect, 2);
  msg("owner", "text", "!jester join");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.connect, 2);
  presence.stop();
});

test("opens one transcript per owner voice presence and closes it on leave", async () => {
  const lifecycle = [];
  const transcript = {
    async start({ channel }) { lifecycle.push(["start", channel]); },
    async finish() { lifecycle.push(["finish"]); },
  };
  const { client, presence } = setup({ channelId: "room", transcript });
  await presence.start();
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, [["start", "room"], ["finish"]]);
  presence.stop();
});

test("rejoins after voice transport failure only while the owner remains present", async () => {
  const client = new EventEmitter();
  const owner = { voice: { channelId: "room" } };
  client.guilds = { cache: new Map([["guild", { members: { cache: new Map([["owner", owner]]) } }]]) };
  const voice = Object.assign(new EventEmitter(), {
    connects: 0,
    async login() {},
    async connect() { this.connects += 1; },
    disconnect() {},
  });
  const transcript = {
    starts: 0, path: null,
    async start() { this.starts++; this.path = "/transcript/current.md"; },
    async finish() { this.path = null; },
  };
  const presence = new Presence({
    client, voice, brain: { async prewarm() {} },
    transcript,
    config: { guildId: "guild", ownerId: "owner", voiceChannelId: "room", transcriptChannelId: "text" },
    privacyFile: join(tmpdir(), `jester-privacy-${randomUUID()}.json`),
    logger: { warn() {} },
  });
  await presence.start();
  assert.equal(voice.connects, 1);
  voice.emit("disconnect");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(voice.connects, 2);
  assert.equal(transcript.starts, 1, "transport reconnect keeps the room transcript");
  voice.emit("disconnect");
  owner.voice.channelId = null;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(voice.connects, 2);
  presence.stop();
});

test("owner arrival, departure and manual leave/rejoin reset conversation attention", async () => {
  const { client, presence } = setup({ channelId: "room" });
  let resets = 0;
  const reasons = [];
  presence.on("reset", (reason) => { resets++; reasons.push(reason); });
  await presence.start();
  assert.equal(resets, 1);
  await presence.leave();
  assert.equal(resets, 2);
  await presence.join();
  assert.equal(resets, 3);
  client.emit("voiceStateUpdate", {}, { id: "guest", guild: { id: "guild" }, channelId: null });
  assert.equal(resets, 3);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  assert.equal(resets, 4);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resets, 5);
  assert.deepEqual(reasons, [undefined, "owner_leave", undefined, "owner_departed", undefined]);
  presence.stop();
});
