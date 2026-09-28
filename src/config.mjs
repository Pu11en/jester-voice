import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export function parseEnv(text) {
  return Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)=(.*)$/);
      if (!match) return [];
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) value = value.slice(1, -1);
      return [[match[1], value]];
    }),
  );
}

async function readEnvFile(path) {
  if (!path) return {};
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Unable to read environment file: ${path}`);
  }
}

export function readConfig(env) {
  const id = (key) => {
    if (!/^\d{17,20}$/.test(env[key] || "")) {
      throw new Error(`Missing or invalid ${key}`);
    }
    return env[key];
  };

  if (!env.DISCORD_BOT_TOKEN) throw new Error("Missing DISCORD_BOT_TOKEN");
  const config = {
    token: env.DISCORD_BOT_TOKEN,
    ownerId: id("DISCORD_OWNER_ID"),
    guildId: id(env.DISCORD_GUILD_ID ? "DISCORD_GUILD_ID" : "VOICE_GUILD_ID"),
    voiceChannelId: id(env.DISCORD_VOICE_CHANNEL_ID ? "DISCORD_VOICE_CHANNEL_ID" : "VOICE_CHANNEL_ID"),
    transcriptChannelId: id(env.DISCORD_TRANSCRIPT_CHANNEL_ID ? "DISCORD_TRANSCRIPT_CHANNEL_ID" : "VOICE_TRANSCRIPT_CHANNEL_ID"),
    python: env.JESTER_PYTHON || "/home/drewp/main-projects/jester-voice/bench/.venv/bin/python",
    modelsDir: env.JESTER_MODELS_DIR || "/home/drewp/main-projects/jester-voice/bench/data/models",
  };
  if (config.voiceChannelId === config.transcriptChannelId) {
    throw new Error("Voice and transcript channels must be different");
  }
  return config;
}

export async function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const local = await readEnvFile(resolve(cwd, ".env"));
  const ebiPath = env.JESTER_EBI_ENV_FILE || local.JESTER_EBI_ENV_FILE ||
    "/home/drewp/main-projects/ebi-agent-chat-relay/.env";
  const ebi = await readEnvFile(ebiPath);
  const voicePath = env.JESTER_VOICE_ENV_FILE || local.JESTER_VOICE_ENV_FILE ||
    resolve(homedir(), ".local/share/drew-ai-voice-transcripts/voice.env");
  const legacyVoice = await readEnvFile(voicePath);
  // The EBI file is the credential source; explicitly supplied process values
  // still win for service managers and tests. Local .env supplies Jester IDs.
  return readConfig({ ...legacyVoice, ...ebi, ...local, ...env });
}
