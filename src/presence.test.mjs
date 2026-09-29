import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { Presence } from "./presence.mjs";

const stateFiles = new Set();
test.after(async () => {
  await Promise.all([...stateFiles].map(path => rm(path, { force: true })));
});

function setup({ channelId = null, transcript = null,
  privacyFile = join(tmpdir(), `jester-privacy-${randomUUID()}.json`),
  stateFile = join(tmpdir(), `jester-presence-${randomUUID()}.json`) } = {}) {
  stateFiles.add(stateFile);
  const client = new EventEmitter();
  const member = { voice: { channelId } };
  client.guilds = { cache: new Map([["guild", { members: { cache: new Map([["owner", member]]) } }]]) };
  const calls = { login: 0, connect: 0, disconnect: 0, prewarm: 0, paused: [], sequence: [] };
  const voice = {
    async login() { calls.login++; },
    async connect() { calls.connect++; },
    disconnect() { calls.disconnect++; calls.sequence.push("disconnect"); },
    setSelfMuted(muted) { calls.sequence.push(`mute:${muted}`); },
    setCapturePaused(paused) { calls.paused.push(paused); },
  };
  const brain = { async prewarm() { calls.prewarm++; } };
  const config = { guildId: "guild", ownerId: "owner", voiceChannelId: "room", transcriptChannelId: "text" };
  return { client, member, calls, presence: new Presence({ client, voice, brain, config, transcript,
    privacyFile, stateFile, logger: { warn() {} } }) };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for presence action");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("startup in an occupied room requests safe listening mode", async () => {
  const modes = [];
  const { presence } = setup({ channelId: "room", transcript: {
    async start() {}, setMode(mode) { modes.push(mode); },
  } });
  let restored = 0;
  presence.on("restoredPresence", () => restored++);
  await presence.start();
  assert.equal(restored, 1);
  assert.deepEqual(modes, ["transcript"]);
  presence.stop();
});

test("spoken leave remains dismissed after process restart until a new room visit", async () => {
  const stateFile = join(tmpdir(), `jester-presence-${randomUUID()}.json`);
  const first = setup({ channelId: "room", stateFile });
  await first.presence.start();
  await first.presence.leave();
  first.presence.stop();
  const restarted = setup({ channelId: "room", stateFile });
  await restarted.presence.start();
  assert.equal(restarted.calls.connect, 0);
  restarted.client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  await new Promise(resolve => setImmediate(resolve));
  restarted.client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.calls.connect, 1);
  restarted.presence.stop();
});

test("restart while owner is absent clears dismissal before the next visit", async () => {
  const stateFile = join(tmpdir(), `jester-presence-${randomUUID()}.json`);
  const first = setup({ channelId: "room", stateFile });
  await first.presence.start();
  await first.presence.leave();
  first.presence.stop();
  const restarted = setup({ channelId: null, stateFile });
  try {
    await restarted.presence.start();
    assert.equal(restarted.calls.connect, 0);
    assert.equal(restarted.presence.dismissed, false);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).dismissed, false);
    restarted.client.emit("voiceStateUpdate", {}, {
      id: "owner", guild: { id: "guild" }, channelId: "room",
    });
    await waitFor(() => restarted.calls.connect === 1);
    assert.equal(restarted.presence.restoredPresence, false);
  } finally { restarted.presence.stop(); }
});

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
    const savedPaused = async () => JSON.parse(await readFile(privacyFile, "utf8")).paused;
    for (let i = 0; i < 100 && (restarted.presence.paused || await savedPaused()); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
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
  assert.deepEqual(calls.sequence.slice(-2), ["mute:true", "disconnect"]);
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
  await waitFor(() => calls.disconnect === 1);
  msg("owner", "text", "!jester join");
  await waitFor(() => calls.connect === 2);
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
    stateFile: join(tmpdir(), `jester-presence-${randomUUID()}.json`),
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

test("owner leave disconnects even when the dismissal cannot be saved", async () => {
  const blocker = join(tmpdir(), `jester-presence-blocker-${randomUUID()}`);
  stateFiles.add(blocker);
  await writeFile(blocker, "a file where the state directory should be");
  const warnings = [];
  const { presence, calls } = setup({ channelId: "room" });
  presence.logger = { warn(...args) { warnings.push(args.join(" ")); } };
  await presence.start();
  await waitFor(() => calls.connect === 1 && presence.joining === null);
  presence.stateFile = join(blocker, "presence.json"); // the disk refuses the next write
  await presence.leave();
  assert.equal(calls.disconnect, 1, "the owner asked Jester to leave the room");
  assert.ok(calls.sequence.includes("mute:true"));
  assert.equal(presence.dismissed, true);
  assert.ok(warnings.some(line => line.includes("dismissal")), "the failed save is reported");
  presence.stop();
});

test("concurrent rejoin requests after a leave connect once", async () => {
  const { presence, calls } = setup({ channelId: "room" });
  await presence.start();
  await waitFor(() => calls.connect === 1 && presence.joining === null);
  await presence.leave();
  await Promise.all([presence.join(), presence.join()]);
  assert.equal(calls.connect, 2, "one initial join and one rejoin");
  presence.stop();
});

test("owner departure after a leave survives a failed dismissal save", async () => {
  const blocker = join(tmpdir(), `jester-presence-blocker-${randomUUID()}`);
  stateFiles.add(blocker);
  await writeFile(blocker, "a file where the state directory should be");
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    const { presence, client } = setup({ channelId: "room" });
    await presence.start();
    await presence.leave();
    presence.stateFile = join(blocker, "presence.json");
    client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
    assert.equal(presence.dismissed, false, "the visit ended, even if the file is stale");
    presence.stop();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("an absent owner costs no brain warm-up, connection or reconnect attempts", async () => {
  const { presence, calls, client } = setup({ channelId: null });
  await presence.start();
  client.emit("voiceStateUpdate", {}, { id: "someone-else", guild: { id: "guild" }, channelId: "room" });
  presence.onVoiceDisconnect(); // a stray transport event while nobody is there
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([calls.prewarm, calls.connect], [0, 0]);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: "room" });
  await waitFor(() => calls.prewarm === 1);
  client.emit("voiceStateUpdate", {}, { id: "owner", guild: { id: "guild" }, channelId: null });
  await new Promise(resolve => setTimeout(resolve, 20));
  presence.onVoiceDisconnect();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([calls.prewarm, calls.connect], [1, 1], "nothing more after the owner left");
  presence.stop();
});
