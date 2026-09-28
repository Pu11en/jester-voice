import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RoomTranscript } from "./transcript.mjs";

const parserDir = "/home/drewp/main-projects/automate 247/allwork";

test("writes all speakers and Jester in allwork's exact transcript format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-room-transcript-"));
  const times = [
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
