import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, utimes, symlink, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RoomTranscript } from "./transcript.mjs";

const parserDir = "/home/drewp/main-projects/automate 247/allwork";

test("writes all speakers and Jester in allwork's exact transcript format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-room-transcript-"));
  const times = [
    new Date("2026-09-27T23:59:59.000Z"),
    new Date("2026-09-27T23:59:59.000Z"),
    new Date("2026-09-27T23:59:59.500Z"),
    new Date("2026-09-28T00:00:00.000Z"),
    new Date("2026-09-28T00:00:01.000Z"),
  ];
  const transcript = new RoomTranscript({ directory: dir, now: () => times.shift() });
  try {
    const path = await transcript.start({ channel: "Jester room" });
    await transcript.record("Kidquick360", "Hello there.");
    await transcript.record("Jester", "Hi, Drew.");
    await transcript.finish();
    const contents = await readFile(path, "utf8");
    assert.match(contents, /^- Session: `[^`]+`$/m);
    assert.match(contents, /^- Channel: Jester room$/m);
    assert.match(contents, /^- Started: 2026-09-27T23:59:59\.000Z$/m);
    assert.match(contents, /^- Ended: 2026-09-28T00:00:01\.000Z$/m);

    // Import the allwork parser itself so this test protects its real regex contract.
    const code = [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import transcript",
      "text = open(sys.argv[2], encoding='utf8').read()",
      "started = transcript.STARTED_RE.search(text)",
      "lines = [transcript.LINE_RE.match(line).groups() for line in text.splitlines() if transcript.LINE_RE.match(line)]",
      "print(json.dumps({'started': started.group(1) if started else None, 'lines': lines}))",
    ].join("; ");
    const python = process.env.JESTER_PYTHON || "/home/drewp/main-projects/jester-voice/bench/.venv/bin/python";
    const result = spawnSync(python, ["-c", code, parserDir, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.started, "2026-09-27T23:59:59.000Z");
    assert.deepEqual(parsed.lines.map(([, , , speaker, text]) => [speaker, text]), [
      ["Kidquick360", "Hello there."],
      ["Jester", "Hi, Drew."],
    ]);
  } finally {
    await transcript.finish();
    await rm(dir, { recursive: true, force: true });
  }
});

test("posts one edited Auto Transcripts attachment and retries a failed first send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-post-"));
  const calls = [];
  let fail = true;
  const message = { async edit(payload) { calls.push(["edit", payload]); return this; } };
  const channel = { async send(payload) {
    calls.push(["send", payload]);
    if (fail) { fail = false; throw new Error("temporary Discord failure"); }
    return message;
  } };
  const client = { channels: { cache: new Map([["text", channel]]) } };
  const transcript = new RoomTranscript({ directory: dir, client, channelId: "text",
    publishIntervalMs: 1, retryMs: 5, logger: { warn() {} } });
  try {
    await transcript.start({ channel: "room" });
    await transcript.record("Drew", "Hello");
    transcript.setMode("transcript");
    await new Promise(resolve => setTimeout(resolve, 30));
    await transcript.record("Friend", "Morning");
    await new Promise(resolve => setTimeout(resolve, 30));
    await transcript.finish();
    assert.equal(calls.filter(([kind]) => kind === "send").length, 2);
    assert.ok(calls.some(([kind, payload]) => kind === "edit" && payload.content.includes("Just listening")));
    assert.ok(calls.some(([kind, payload]) => kind === "edit" && payload.content.includes("Ended")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prunes only old transcript files inside its directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-prune-"));
  const old = join(dir, "11111111-1111-1111-1111-111111111111.md");
  const recent = join(dir, "22222222-2222-2222-2222-222222222222.md");
  const unrelated = join(dir, "notes.md");
  const external = join(dir, "external.md");
  const oldDate = new Date("2026-08-01T00:00:00Z");
  try {
    await writeFile(old, "old");
    await writeFile(recent, "recent");
    await writeFile(unrelated, "keep");
    await symlink(old, external);
    await utimes(old, oldDate, oldDate);
    const transcript = new RoomTranscript({ directory: dir, now: () => new Date("2026-09-28T00:00:00Z") });
    await transcript.prune();
    await assert.rejects(stat(old), { code: "ENOENT" });
    assert.equal(await readFile(recent, "utf8"), "recent");
    assert.equal(await readFile(unrelated, "utf8"), "keep");
    assert.equal((await lstat(external)).isSymbolicLink(), true, "symlink is not removed by pruning");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed retention cleanup never prevents recording the new transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-prune-fail-"));
  const warnings = [];
  try {
    const transcript = new RoomTranscript({ directory: dir, logger: { warn: (...a) => warnings.push(a.join(" ")) } });
    transcript.prune = async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
    const path = await transcript.start({ channel: "room" });
    assert.match(await readFile(path, "utf8"), /# Voice transcript/);
    assert.ok(warnings.some(line => line.includes("permission denied")), "the failed cleanup is reported");
    await transcript.finish();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
