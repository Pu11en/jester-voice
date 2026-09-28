import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
