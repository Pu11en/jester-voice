import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendBounded } from "./bounded-log.mjs";

test("bounded append keeps the header and newest complete records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jester-bounded-log-"));
  const path = join(directory, "log.md");
  try {
    await appendBounded(path, "header\n", 24, 1);
    await appendBounded(path, "old-record-1234\n", 24, 1);
    await appendBounded(path, "new-record-5678\n", 24, 1);
    const result = await readFile(path, "utf8");
    assert.equal(result, "header\nnew-record-5678\n");
    assert.ok(Buffer.byteLength(result) <= 24);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
