import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionJournal } from "./action-journal.mjs";

test("an uncertain action keeps its identity across restart and refuses a second POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-actions-"));
  const file = join(dir, "actions.json");
  let now = 1000;
  try {
    const first = new ActionJournal({ file, now: () => now });
    await first.start();
    const prepared = await first.prepare("spoken", "1553899450227757156", "check the site");
    assert.equal(prepared.fresh, true);
    await first.close();
    const second = new ActionJournal({ file, now: () => now });
    await second.start();
    const repeated = await second.prepare("spoken", "1553899450227757156", "check the site");
    assert.equal(repeated.fresh, false);
    assert.equal(repeated.item.id, prepared.item.id);
    await second.finish(repeated.item, "posted", { status: "posted" });
    now += 1000;
    assert.equal((await second.prepare("spoken", "1553899450227757156", "check the site")).fresh, false);
    now += 300_000;
    assert.equal((await second.prepare("spoken", "1553899450227757156", "check the site")).fresh, true);
    await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent copies of one command both wait for its durable identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-actions-race-"));
  const journal = new ActionJournal({ file: join(dir, "actions.json") });
  let release;
  const pending = [];
  try {
    await journal.start();
    journal.saving = new Promise(resolve => { release = resolve; });
    let repeatedReturned = false;
    pending.push(journal.prepare("spoken", "1553899450227757156", "check login"));
    pending.push(journal.prepare("spoken", "1553899450227757156", "check login")
      .then(result => { repeatedReturned = true; return result; }));
    await new Promise(setImmediate);
    assert.equal(repeatedReturned, false, "an unsaved item must not reach the caller");
    assert.deepEqual(JSON.parse(await readFile(journal.file, "utf8")), []);
    release();
    const [first, second] = await Promise.all(pending);
    assert.equal(first.fresh, true);
    assert.equal(second.fresh, false);
    assert.equal(first.item.id, second.item.id);
    assert.equal(JSON.parse(await readFile(journal.file, "utf8"))[0].id, first.item.id);
  } finally {
    release?.();
    await Promise.allSettled(pending);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed preparation cannot be reused and a later disk recovery can save again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-actions-failure-"));
  const file = join(dir, "actions.json");
  const journal = new ActionJournal({ file });
  try {
    await journal.start();
    await writeFile(join(dir, "blocked"), "not a directory");
    journal.file = join(dir, "blocked", "actions.json");
    await assert.rejects(journal.prepare("spoken", "1553899450227757156", "check login"));
    await assert.rejects(journal.prepare("spoken", "1553899450227757156", "check login"));
    journal.file = file;
    const recovered = await journal.prepare("spoken", "1553899450227757156", "check login");
    assert.equal(recovered.fresh, true);
    assert.equal(JSON.parse(await readFile(file, "utf8"))[0].id, recovered.item.id);
  } finally {
    await journal.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed finish keeps the durable pending status for receipt reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-actions-finish-"));
  const file = join(dir, "actions.json");
  const journal = new ActionJournal({ file });
  try {
    await journal.start();
    const prepared = await journal.prepare("spoken", "1553899450227757156", "check login");
    await writeFile(join(dir, "blocked"), "not a directory");
    journal.file = join(dir, "blocked", "actions.json");
    await assert.rejects(journal.finish(prepared.item, "posted", { status: "posted" }));
    journal.file = file;
    const repeated = await journal.prepare("spoken", "1553899450227757156", "check login");
    assert.equal(repeated.item.status, "pending");
    assert.equal(repeated.item.id, prepared.item.id);
    await journal.finish(repeated.item, "posted", { status: "posted" });
    assert.equal(JSON.parse(await readFile(file, "utf8"))[0].status, "posted");
  } finally {
    await journal.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
