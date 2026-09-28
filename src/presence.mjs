import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const LEAVE_PHRASE = /^\s*jester[\s,]+(?:leave|disconnect)\s*[.!?]*\s*$/i;
const PAUSE_PHRASE = /^\s*jester[\s,]+(?:pause|stop)\s+(?:recording|transcribing)\s*[.!?]*\s*$/i;
const PAUSE_BUTTON = "jester:recording:pause";
const RESUME_BUTTON = "jester:recording:resume";

/** Auto-join and owner escape hatches for one configured Discord voice room. */
export class Presence extends EventEmitter {
  constructor({ client, voice, brain, config, transcript = null, logger = console,
    privacyFile = join(homedir(), ".local/share/jester-voice/privacy.json") } = {}) {
    super();
    if (!client || !voice || !brain || !config) {
      throw new Error("client, voice, brain, and config are required");
    }
    this.client = client;
    this.voice = voice;
    this.brain = brain;
    this.config = config;
    this.transcript = transcript;
    this.logger = logger;
    this.privacyFile = privacyFile;
    this.paused = false;
    this.notice = null;
    this.inPresence = false;
    this.dismissed = false;
    this.joined = false;
    this.joining = null;
    this.onVoiceState = (_oldState, newState) => this.#voiceState(newState);
    this.onMessage = (message) => this.#message(message);
    this.onInteraction = (interaction) => { void this.#interaction(interaction); };
    this.onVoiceDisconnect = () => { this.joined = false; this.#recoverVoice(); };
    this.recoveryAttempt = 0;
    this.recoveryTimer = null;
  }

  async start() {
    await this.#loadPrivacy();
    this.voice.setCapturePaused?.(this.paused);
    this.client.on("voiceStateUpdate", this.onVoiceState);
    this.client.on("messageCreate", this.onMessage);
    this.client.on("interactionCreate", this.onInteraction);
    this.voice.on?.("disconnect", this.onVoiceDisconnect);
    try {
      await this.voice.login();
      await this.#setPresence(this.#ownerChannelId() === this.config.voiceChannelId);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.closed = true;
    this.client.off("voiceStateUpdate", this.onVoiceState);
    this.client.off("messageCreate", this.onMessage);
    this.client.off("interactionCreate", this.onInteraction);
    this.voice.off?.("disconnect", this.onVoiceDisconnect);
    clearTimeout(this.recoveryTimer);
  }

  /** Consume a clearly addressed owner voice command before it reaches Luna. */
  async handleOwnerTurn(text) {
    if (PAUSE_PHRASE.test(text || "")) {
      await this.#setPaused(true);
      return true;
    }
    if (!LEAVE_PHRASE.test(text || "")) return false;
    await this.leave();
    return true;
  }

  async join() {
    if (!this.inPresence || this.joined || this.joining) return this.joining;
    this.emit("reset");
    this.dismissed = false;
    this.joining = Promise.resolve(this.voice.connect())
      .then(async () => {
        this.joined = true;
        if (!this.inPresence || this.dismissed) {
          this.voice.disconnect();
          this.joined = false;
          return;
        }
        const channel = this.client.channels?.cache?.get(this.config.voiceChannelId)?.name || this.config.voiceChannelId;
        // A transport reconnect is still the same owner room presence. Keep
        // its transcript and mode rather than splitting the room session.
        if (!this.transcript?.path) await this.transcript?.start({ channel });
        await this.#showNotice();
        await this.brain.prewarm();
      })
      .catch((error) => this.logger.warn?.("[presence] join:", error.message))
      .finally(() => { this.joining = null; });
    return this.joining;
  }

  async leave() {
    this.dismissed = true;
    this.emit("reset", "owner_leave");
    clearTimeout(this.recoveryTimer);
    if (this.joining) await this.joining;
    this.voice.setSelfMuted?.(true);
    this.voice.disconnect();
    this.joined = false;
    await this.transcript?.finish();
  }

  async #voiceState(state) {
    if (String(state.id) !== String(this.config.ownerId) || state.guild?.id !== this.config.guildId) return;
    await this.#setPresence(state.channelId === this.config.voiceChannelId);
  }

  async #setPresence(present) {
    if (present === this.inPresence) return;
    this.inPresence = present;
    if (!present) {
      this.emit("reset", "owner_departed");
      this.dismissed = false;
      clearTimeout(this.recoveryTimer);
      if (this.joining) await this.joining;
      this.voice.disconnect();
      this.joined = false;
      await this.transcript?.finish();
    } else if (!this.dismissed) {
      await this.join();
    }
  }

  async #message(message) {
    if (message.author?.bot || message.guildId !== this.config.guildId ||
        message.channelId !== this.config.transcriptChannelId) return;
    const command = message.content.trim().toLowerCase();
    const owner = String(message.author.id) === String(this.config.ownerId);
    if (command === "!jester pause" && this.#inRoom(message.author.id)) await this.#setPaused(true);
    else if (command === "!jester resume" && owner) await this.#setPaused(false);
    else if (command === "!jester leave" && owner) await this.leave();
    else if (command === "!jester join" && owner && this.inPresence) await this.join();
  }

  #inRoom(userId) {
    const guild = this.client.guilds?.cache?.get(this.config.guildId);
    return guild?.voiceStates?.cache?.get(String(userId))?.channelId === this.config.voiceChannelId ||
      guild?.members?.cache?.get(String(userId))?.voice?.channelId === this.config.voiceChannelId;
  }

  async #interaction(interaction) {
    if (!interaction.isButton?.() || interaction.guildId !== this.config.guildId ||
        interaction.channelId !== this.config.transcriptChannelId ||
        ![PAUSE_BUTTON, RESUME_BUTTON].includes(interaction.customId)) return;
    const owner = String(interaction.user?.id) === String(this.config.ownerId);
    if (interaction.customId === PAUSE_BUTTON && !this.#inRoom(interaction.user?.id)) {
      await interaction.reply({ content: "Only someone in the voice room can pause recording.", ephemeral: true });
      return;
    }
    if (interaction.customId === RESUME_BUTTON && !owner) {
      await interaction.reply({ content: "Only Drew can resume recording.", ephemeral: true });
      return;
    }
    try {
      await this.#setPaused(interaction.customId === PAUSE_BUTTON);
      await interaction.reply({ content: this.paused ? "Recording paused." : "Recording resumed.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `Recording control failed: ${error.message}`, ephemeral: true });
    }
  }

  async #loadPrivacy() {
    try {
      this.paused = JSON.parse(await readFile(this.privacyFile, "utf8")).paused === true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async #setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    const speakers = this.voice.setCapturePaused?.(paused) || [];
    if (paused) this.emit("capturePaused", speakers);
    await mkdir(dirname(this.privacyFile), { recursive: true });
    const temp = `${this.privacyFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ paused }), { mode: 0o600 });
    await rename(temp, this.privacyFile);
    await this.#showNotice();
  }

  async #showNotice() {
    const channel = this.client.channels?.cache?.get(this.config.transcriptChannelId) ||
      await this.client.channels?.fetch?.(this.config.transcriptChannelId);
    if (!channel?.send) return;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(PAUSE_BUTTON).setLabel("Pause recording")
        .setStyle(ButtonStyle.Danger).setDisabled(this.paused),
      new ButtonBuilder().setCustomId(RESUME_BUTTON).setLabel("Resume recording")
        .setStyle(ButtonStyle.Success).setDisabled(!this.paused),
    );
    const payload = {
      content: this.paused
        ? "Jester is in this voice room. Recording is paused. Only Drew can resume it."
        : "Jester is in this voice room and transcribing speech. Anyone here can pause recording; only Drew can resume it.",
      components: [row],
    };
    try {
      if (this.notice) this.notice = await this.notice.edit(payload);
      else this.notice = await channel.send(payload);
    } catch (error) { this.logger.warn?.("[presence] recording notice:", error.message); }
  }

  #ownerChannelId() {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const voiceState = guild?.voiceStates?.cache?.get(this.config.ownerId);
    if (voiceState) return voiceState.channelId;
    return guild?.members?.cache?.get(this.config.ownerId)?.voice?.channelId ?? null;
  }

  #recoverVoice() {
    if (!this.inPresence || this.dismissed || this.closed || this.recoveryAttempt >= 5) return;
    if (this.#ownerChannelId() !== this.config.voiceChannelId) return;
    const delay = Math.min(5_000, 250 * (2 ** this.recoveryAttempt++));
    this.recoveryTimer = setTimeout(async () => {
      if (!this.inPresence || this.dismissed) return;
      if (this.#ownerChannelId() !== this.config.voiceChannelId) return;
      await this.join();
      if (!this.joined) this.#recoverVoice();
      else this.recoveryAttempt = 0;
    }, delay);
    this.recoveryTimer.unref?.();
  }
}
