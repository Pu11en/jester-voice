/** Credentials Jester holds that no child process needs: the Discord bot token and
 *  the EBI control-plane secrets. The Codex brain reads untrusted thread text, so
 *  its process must not be able to read them from its environment. */
export const PRIVATE_ENV_KEYS = Object.freeze([
  "DISCORD_BOT_TOKEN", "JESTER_EBI_API_SECRET", "CCDB_API_SECRET",
]);

export function childEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const key of PRIVATE_ENV_KEYS) delete env[key];
  return env;
}
