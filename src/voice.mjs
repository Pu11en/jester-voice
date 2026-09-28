import { Client, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";

const INPUT_RATE = 48_000;
const OUTPUT_RATE = 16_000;
const INPUT_CHANNELS = 2;
const FRAME_SAMPLES = 512; // 32 ms at 16 kHz, as expected by the worker.

/** Never forward raw Discord voice debug payloads; they can contain session keys. */
export function voiceDebugWarning(message) {
  return /Failed to decrypt a packet/i.test(message) ? "[voice] DAVE audio packet decrypt failed" : null;
}

/** Convert interleaved 48 kHz stereo s16le PCM to 16 kHz mono s16le PCM. */
export function downmixResample48kTo16kMono(pcm) {
  if (pcm.length % (INPUT_CHANNELS * 2) !== 0) {
    throw new Error("48 kHz stereo PCM must contain complete samples");
  }
  const samples = new Int16Array(pcm.length / 4);
  for (let i = 0, j = 0; i < pcm.length; i += 4, j += 1) {
    samples[j] = Math.round((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2);
  }
  const output = Buffer.alloc(Math.floor(samples.length / 3) * 2);
  for (let i = 0; i < output.length / 2; i += 1) {
    // A three-sample box filter reduces aliasing before decimation.
    output.writeInt16LE(Math.round((samples[i * 3] + samples[i * 3 + 1] + samples[i * 3 + 2]) / 3), i * 2);
  }
  return output;
}

/** Keep conversion phase and 32 ms framing stable across arbitrary decoder chunks. */
export function createPcmInput(onFrame) {
  let monoPending = [];
  let framePending = Buffer.alloc(0);
  return {
    write(stereoPcm) {
      if (stereoPcm.length % 4 !== 0) {
        throw new Error("48 kHz stereo PCM must contain complete samples");
      }
      for (let i = 0; i < stereoPcm.length; i += 4) {
        monoPending.push((stereoPcm.readInt16LE(i) + stereoPcm.readInt16LE(i + 2)) / 2);
      }
      const convertedSamples = Math.floor(monoPending.length / 3);
      if (!convertedSamples) return;
      const converted = Buffer.alloc(convertedSamples * 2);
      for (let i = 0; i < convertedSamples; i += 1) {
        const sample = Math.round((monoPending[i * 3] + monoPending[i * 3 + 1] + monoPending[i * 3 + 2]) / 3);
        converted.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
      }
      monoPending = monoPending.slice(convertedSamples * 3);
      framePending = Buffer.concat([framePending, converted]);
      const frameBytes = FRAME_SAMPLES * 2;
      while (framePending.length >= frameBytes) {
        onFrame(framePending.subarray(0, frameBytes));
        framePending = framePending.subarray(frameBytes);
      }
    },
    reset() {
      monoPending = [];
      framePending = Buffer.alloc(0);
    },
  };
}

/** Measure only time the Discord player reports as actively playing. */
export function createPlayedTimeTracker(now = () => performance.now()) {
  const tracks = new Map();
  let active = null;
  return {
    transition(oldStatus, newStatus) {
      const time = now();
      if (active && oldStatus === AudioPlayerStatus.Playing) {
        active.total += Math.max(0, time - active.startedAt);
        active.startedAt = null;
      }
      if (active && newStatus === AudioPlayerStatus.Playing) active.startedAt = time;
      if (newStatus === AudioPlayerStatus.Idle && active) active = null;
    },
    begin(id, resource = null) {
      const track = { total: 0, startedAt: null, resource };
      tracks.set(String(id), track);
      active = track;
    },
    playedMs(id) {
      const track = tracks.get(String(id));
      if (!track) return 0;
      const live = track === active && track.startedAt !== null ? now() - track.startedAt : 0;
      const activeMs = Math.max(0, Math.round(track.total + live));
      // The player remains Playing while it bridges sentence gaps with Opus
      // silence. Resource playbackDuration counts only PCM-backed packets.
      return track.resource ? Math.min(activeMs, track.resource.playbackDuration) : activeMs;
    },
  };
}

/** Discord voice transport; `onAudio` receives complete 16 kHz mono worker frames. */
export function createVoice({
  config,
  onAudio = () => {},
  logger = console,
  client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ] }),
  voice = {
    AudioPlayerStatus, createAudioPlayer, createAudioResource, EndBehaviorType,
    entersState, joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  },
  createDecoder = () => new prism.opus.Decoder({ rate: INPUT_RATE, channels: 2, frameSize: 960 }),
  now,
} = {}) {
  if (!config) throw new Error("config is required");
  // Luna can pause between completed sentences for longer than Discord's default
  // five missing frames (100 ms). Keep the resource alive and let the player send
  // silence packets until the next PCM chunk arrives or the stream actually ends.
  const player = voice.createAudioPlayer({
    behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause, maxMissedFrames: Infinity },
  });
  const played = createPlayedTimeTracker(now);
  player.on("stateChange", (oldState, newState) => {
    played.transition(oldState.status, newState.status);
  });
  const receivers = new Map();
  const seenSpeakers = new Set();
  const events = new EventEmitter();
  let connection = null;
  let loggedIn = false;
  let connectionTimer = null;
  let intentionalDisconnect = false;
  let capturePaused = false;
  let lastDecryptWarningAt = 0;

  function capture(userId) {
    if (capturePaused || receivers.has(userId) || userId === client.user?.id) return;
    const guild = client.guilds.cache.get(config.guildId);
    const member = guild?.members.cache.get(userId);
    if (member?.user?.bot || client.users.cache.get(userId)?.bot) return;
    seenSpeakers.add(String(userId));
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 1_000 },
    });
    const decoder = createDecoder();
    const input = createPcmInput((pcm) => { if (!capturePaused) onAudio(userId, pcm); });
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      receivers.delete(userId);
      input.reset();
      opus.unpipe(decoder);
      opus.destroy();
      decoder.destroy();
    };
    receivers.set(userId, { finish, opus, decoder });
    decoder.on("data", (pcm) => {
      try { input.write(pcm); } catch (error) { logger.warn?.("[voice] invalid PCM:", error.message); finish(); }
    });
    decoder.once("end", finish);
    decoder.once("close", finish);
    decoder.once("error", (error) => { logger.warn?.("[voice] decoder:", error.message); finish(); });
    opus.once("error", (error) => { logger.warn?.("[voice] receiver:", error.message); finish(); });
    opus.once("close", finish);
    opus.pipe(decoder);
  }

  function disconnect() {
    intentionalDisconnect = true;
    clearTimeout(connectionTimer);
    connectionTimer = null;
    for (const { finish } of [...receivers.values()]) finish();
    voiceConnectionDestroy();
    player.stop(true);
    intentionalDisconnect = false;
  }

  function voiceConnectionDestroy() {
    const oldConnection = connection;
    connection = null;
    if (oldConnection && oldConnection.state.status !== voice.VoiceConnectionStatus.Destroyed) oldConnection.destroy();
  }

  return {
    client,
    player,
    setCapturePaused(paused) {
      capturePaused = Boolean(paused);
      if (capturePaused) for (const { finish } of [...receivers.values()]) finish();
      if (capturePaused) {
        const speakers = [...seenSpeakers];
        seenSpeakers.clear();
        return speakers;
      }
      return [];
    },
    async login() {
      if (!loggedIn) {
        const ready = new Promise((resolve, reject) => {
          client.once("ready", resolve);
          client.once("error", reject);
        });
        await client.login(config.token);
        await ready;
        loggedIn = true;
      }
    },
    async connect() {
      await this.login();
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) throw new Error("Configured Discord guild is unavailable");
      connection = voice.joinVoiceChannel({
        channelId: config.voiceChannelId,
        guildId: config.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        debug: true,
      });
      connection.on("debug", (message) => {
        const warning = voiceDebugWarning(message);
        if (!warning || Date.now() - lastDecryptWarningAt < 60_000) return;
        lastDecryptWarningAt = Date.now();
        logger.warn?.(warning);
      });
      connection.on("error", (error) => logger.warn?.("[voice] connection:", error.message));
      const watchedConnection = connection;
      connection.on("stateChange", (_oldState, newState) => {
        if (connection !== watchedConnection) return;
        if (![voice.VoiceConnectionStatus.Disconnected, voice.VoiceConnectionStatus.Destroyed].includes(newState.status) || intentionalDisconnect) return;
        clearTimeout(connectionTimer);
        connectionTimer = setTimeout(() => {
          if (connection !== watchedConnection) return;
          if (connection?.state.status !== voice.VoiceConnectionStatus.Ready &&
              connection?.state.status !== voice.VoiceConnectionStatus.Destroyed) {
            disconnect();
            events.emit("disconnect");
          } else if (connection?.state.status === voice.VoiceConnectionStatus.Destroyed) {
            disconnect();
            events.emit("disconnect");
          }
        }, newState.status === voice.VoiceConnectionStatus.Destroyed ? 0 : 5_000);
        connectionTimer.unref?.();
      });
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 20_000);
      connection.subscribe(player);
      connection.receiver.speaking.on("start", capture);
      return connection;
    },
    play(id, pcmStream) {
      const stream = Buffer.isBuffer(pcmStream) ? Readable.from([pcmStream]) : pcmStream;
      if (!stream || typeof stream.pipe !== "function") throw new Error("play expects a PCM Readable stream or Buffer");
      const resource = voice.createAudioResource(stream, { inputType: voice.StreamType.Raw });
      played.begin(id, resource);
      player.play(resource);
    },
    stopNow() {
      player.stop(true);
    },
    playedMs(id) {
      return played.playedMs(id);
    },
    displayName(userId) {
      const guild = client.guilds.cache.get(config.guildId);
      const member = guild?.members.cache.get(String(userId));
      if (String(userId) === String(client.user?.id)) return client.user?.username || "Jester";
      return member?.displayName || member?.user?.username || client.users.cache.get(String(userId))?.username || String(userId);
    },
    disconnect,
    async destroy() {
      disconnect();
      if (loggedIn) await client.destroy();
      loggedIn = false;
    },
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
  };
}
