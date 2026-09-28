import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, parseEnv, readConfig } from "./config.mjs";

const valid = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_OWNER_ID: "12345678901234567",
  DISCORD_GUILD_ID: "12345678901234568",
  DISCORD_VOICE_CHANNEL_ID: "12345678901234569",
  DISCORD_TRANSCRIPT_CHANNEL_ID: "12345678901234570",
};

test("parses env files and validates configured Discord identities", async () => {
  assert.deepEqual(parseEnv("# comment\nexport A='one'\nB=two"), { A: "one", B: "two" });
  assert.equal(readConfig(valid).ownerId, valid.DISCORD_OWNER_ID);
  assert.throws(() => readConfig({ ...valid, DISCORD_OWNER_ID: "bad" }), /DISCORD_OWNER_ID/);

  const dir = await mkdtemp(join(tmpdir(), "jester-config-"));
  try {
    await writeFile(join(dir, ".env"), "DISCORD_GUILD_ID=12345678901234568\nDISCORD_VOICE_CHANNEL_ID=12345678901234569\nDISCORD_TRANSCRIPT_CHANNEL_ID=12345678901234570\n");
    const ebiPath = join(dir, "ebi.env");
    await writeFile(ebiPath, "DISCORD_BOT_TOKEN=from-ebi\nDISCORD_OWNER_ID=12345678901234567\n");
    const config = await loadConfig({ cwd: dir, env: { JESTER_EBI_ENV_FILE: ebiPath } });
    assert.equal(config.token, "from-ebi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prefers Jester channel IDs and falls back to the old voice env file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jester-legacy-config-"));
  try {
    const ebiPath = join(dir, "ebi.env");
    const voicePath = join(dir, "voice.env");
    await writeFile(ebiPath, "DISCORD_BOT_TOKEN=fake-secret\nDISCORD_OWNER_ID=12345678901234567\n");
    await writeFile(voicePath, "VOICE_GUILD_ID=12345678901234568\nVOICE_CHANNEL_ID=12345678901234569\nVOICE_TRANSCRIPT_CHANNEL_ID=12345678901234570\n");
    const legacy = await loadConfig({ cwd: dir, env: {
      JESTER_EBI_ENV_FILE: ebiPath, JESTER_VOICE_ENV_FILE: voicePath,
    } });
    assert.equal(legacy.guildId, "12345678901234568");
    assert.equal(legacy.voiceChannelId, "12345678901234569");
    assert.equal(legacy.transcriptChannelId, "12345678901234570");
    const explicit = await loadConfig({ cwd: dir, env: {
      JESTER_EBI_ENV_FILE: ebiPath, JESTER_VOICE_ENV_FILE: voicePath,
      DISCORD_GUILD_ID: "22345678901234568", DISCORD_VOICE_CHANNEL_ID: "22345678901234569",
      DISCORD_TRANSCRIPT_CHANNEL_ID: "22345678901234570",
    } });
    assert.equal(explicit.guildId, "22345678901234568");
    assert.equal(explicit.voiceChannelId, "22345678901234569");
    assert.equal(explicit.transcriptChannelId, "22345678901234570");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
