import assert from "node:assert/strict";
import test from "node:test";
import { childEnv } from "./child-env.mjs";

test("child processes keep HOME, PATH and XDG dirs so the Claude CLI finds its login", () => {
  const env = childEnv({
    HOME: "/home/owner", PATH: "/usr/bin", USER: "owner",
    XDG_CONFIG_HOME: "/home/owner/.config", XDG_DATA_HOME: "/home/owner/.local/share",
    XDG_STATE_HOME: "/home/owner/.local/state", XDG_CACHE_HOME: "/home/owner/.cache",
    XDG_RUNTIME_DIR: "/run/user/1000", CLAUDE_CONFIG_DIR: "/home/owner/.claude",
    DISCORD_BOT_TOKEN: "discord-secret", JESTER_EBI_API_SECRET: "ebi-secret", CCDB_API_SECRET: "ccdb-secret",
  }, { JESTER_MODELS_DIR: "/models" });
  for (const key of ["HOME", "PATH", "USER", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CLAUDE_CONFIG_DIR", "JESTER_MODELS_DIR"]) {
    assert.ok(env[key], `${key} is kept`);
  }
  for (const key of ["DISCORD_BOT_TOKEN", "JESTER_EBI_API_SECRET", "CCDB_API_SECRET"]) {
    assert.equal(env[key], undefined, `${key} is stripped`);
  }
});

test("secrets passed as extra values are stripped too", () => {
  const env = childEnv({ HOME: "/home/owner" }, { DISCORD_BOT_TOKEN: "x", CCDB_API_SECRET: "y" });
  assert.deepEqual(env, { HOME: "/home/owner" });
});
