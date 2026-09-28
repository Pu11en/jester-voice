import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Presence } from "./presence.mjs";

function setup({ channelId = null, transcript = null } = {}) {
  const client = new EventEmitter();
  const member = { voice: { channelId } };
  client.guilds = { cache: new Map([["guild", { members: { cache: new Map([["owner", member]]) } }]]) };
  const calls = { login: 0, connect: 0, disconnect: 0, prewarm: 0 };
  const voice = {
    async login() { calls.login++; },
    async connect() { calls.connect++; },
    disconnect() { calls.disconnect++; },
  };
  const brain = { async prewarm() { calls.prewarm++; } };
  const config = { guildId: "guild", ownerId: "owner", voiceChannelId: "room", transcriptChannelId: "text" };
  return { client, member, calls, presence: new Presence({ client, voice, brain, config, transcript, logger: { warn() {} } }) };
}

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
