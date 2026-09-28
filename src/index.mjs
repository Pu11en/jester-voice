import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { Brain } from "./brain.mjs";
import { loadConfig } from "./config.mjs";
import { Conversation } from "./conversation.mjs";
import { Presence } from "./presence.mjs";
import { RoomTranscript } from "./transcript.mjs";
import { createVoice } from "./voice.mjs";
import { WorkerClient } from "./worker-client.mjs";
import { EbiClient } from "./ebi-client.mjs";
import { OwnerRouter } from "./owner-router.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function startApp({ config, createVoiceImpl = createVoice,
  createWorkerImpl = (options) => new WorkerClient(options),
  createBrainImpl = (options) => new Brain(options),
  createTranscriptImpl = (options) => new RoomTranscript(options),
  createPresenceImpl = (options) => new Presence(options),
  createConversationImpl = (options) => new Conversation(options),
} = {}) {
  config ||= await loadConfig();
  const stallClip = await readFile(resolve(projectRoot, "assets/thinking.pcm"));
  const unavailableClip = await readFile(resolve(projectRoot, "assets/unavailable.pcm"));
  const worker = createWorkerImpl({
    command: config.python,
    args: [resolve(projectRoot, "worker/speech.py")],
    cwd: projectRoot,
    env: { ...process.env, JESTER_MODELS_DIR: config.modelsDir },
  });
  const voice = createVoiceImpl({ config, onAudio: (speaker, pcm) => {
    worker.send({ op: "audio", speaker, pcm: pcm.toString("base64") });
  } });
  const brain = createBrainImpl({});
  const ownerRouter = new OwnerRouter({
    client: new EbiClient({ baseUrl: config.ebiApiUrl, secret: config.ebiApiSecret }),
    ownerId: config.ownerId,
  });
  const transcript = createTranscriptImpl({ client: voice.client, channelId: config.transcriptChannelId });
  const presence = createPresenceImpl({ client: voice.client, voice, brain, config, transcript });
  const conversation = createConversationImpl({ worker, brain, voice, ownerId: config.ownerId,
    presence, transcript, stallClip, unavailableClip, ownerRouter });

  let started = false;
  let closing = null;
  return {
    worker, voice, brain, presence, conversation, transcript,
    async start() {
      if (started) return;
      await worker.start();
      conversation.start();
      try {
        await presence.start();
        started = true;
      } catch (error) {
        await this.close();
        throw error;
      }
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        const errors = [];
        for (const close of [
          () => presence.stop(),
          () => conversation.close(),
          () => brain.close(),
          () => worker.close(),
          () => voice.destroy(),
        ]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        started = false;
        if (errors.length) throw new AggregateError(errors, "One or more Jester services failed to close");
      })();
      return closing;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[jester] shutting down on ${signal}`);
    try { await app?.close(); process.exitCode = 0; }
    catch (error) { console.error(`[jester] shutdown failed: ${error.message}`); process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void stop("SIGINT"); });
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  try {
    app = await startApp();
    await app.start();
    console.log("[jester] ready; join the configured voice room to talk");
  } catch (error) {
    console.error(`[jester] startup failed: ${error.message}`);
    await app?.close().catch(() => {});
    process.exitCode = 1;
  }
}
