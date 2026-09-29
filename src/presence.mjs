import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const LEAVE_PHRASE = /^\s*(?:(?:hey|yo)\s+)?jester[\s,]+(?:(?:shut\s+up[,\s]+)?(?:leave|disconnect|go\s+away))\s*[.!?]*\s*$/i;
const ACTIVE_DISCONNECT = /^\s*(?:no[,\s]+)?disconnect(?:[,\s]+leave)?\s*[.!?]*\s*$/i;
const PAUSE_PHRASE = /^\s*jester[\s,]+(?:pause|stop)\s+(?:recording|transcribing)\s*[.!?]*\s*$/i;
const PAUSE_BUTTON = "jester:recording:pause";
const RESUME_BUTTON = "jester:recording:resume";

/** Auto-join and owner escape hatches for one configured Discord voice room. */
export class Presence extends EventEmitter {
  constructor({ client, voice, brain, config, transcript = null, logger = console,
    privacyFile = join(homedir(), ".local/share/jester-voice/privacy.json"),
    stateFile = join(homedir(), ".local/share/jester-voice/presence.json") } = {}) {
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
    this.stateFile = stateFile;
    this.paused = false;
    this.notice = null;
    this.inPresence = false;
    this.dismissed = false;
    this.restoredPresence = false;
    this.joined = false;
    this.joining = null;
    this.leaving = null;
    this.onVoiceState = (_oldState, newState) => this.#voiceState(newState);
    this.onMessage = (message) => this.#message(message);
    this.onInteraction = (interaction) => { void this.#interaction(interaction); };
    this.onVoiceDisconnect = () => { this.joined = false; this.#recoverVoice(); };
    this.recoveryAttempt = 0;
    this.recoveryTimer = null;
  }

  async start() {
    await this.#loadPrivacy();
    await this.#loadDismissed();
    this.voice.setCapturePaused?.(this.paused);
    this.client.on("voiceStateUpdate", this.onVoiceState);
    this.client.on("messageCreate", this.onMessage);
    this.client.on("interactionCreate", this.onInteraction);
    this.voice.on?.("disconnect", this.onVoiceDisconnect);
    try {
      await this.voice.login();
      const ownerAlreadyPresent = this.#ownerChannelId() === this.config.voiceChannelId;
      // A saved dismissal belongs to the previous room visit. If startup
      // observes the owner absent, that visit ended while we were offline.
      if (!ownerAlreadyPresent && this.dismissed) {
        await this.#saveDismissed(false);
        this.dismissed = false;
      }
      this.restoredPresence = ownerAlreadyPresent && !this.dismissed;
      if (this.restoredPresence) this.emit("restoredPresence");
      await this.#setPresence(ownerAlreadyPresent);
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

  clearRestoredPresence() { this.restoredPresence = false; }

  /** Consume a clearly addressed owner voice command before it reaches Luna. */
  async handleOwnerTurn(text, { allowBareDisconnect = false } = {}) {
    if (PAUSE_PHRASE.test(text || "")) {
      await this.#setPaused(true);
      return true;
    }
    if (!LEAVE_PHRASE.test(text || "") && !(allowBareDisconnect && ACTIVE_DISCONNECT.test(text || ""))) return false;
    await this.leave();
    return true;
  }

  async join() {
    if (this.leaving) await this.leaving;
    if (!this.inPresence || this.joined || this.joining) return this.joining;
    if (this.dismissed) await this.#saveDismissed(false);
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
        if (this.restoredPresence) this.transcript?.setMode?.("transcript");
        await this.#showNotice();
        await this.brain.prewarm();
      })
      .catch((error) => this.logger.warn?.("[presence] join:", error.message))
      .finally(() => { this.joining = null; });
    return this.joining;
  }

  async leave() {
    if (this.leaving) return this.leaving;
    this.leaving = (async () => {
      this.dismissed = true;
      await this.#saveDismissed(true);
      this.emit("reset", "owner_leave");
      clearTimeout(this.recoveryTimer);
      if (this.joining) await this.joining;
      this.voice.setSelfMuted?.(true);
      this.voice.disconnect();
      this.joined = false;
      await this.transcript?.finish();
    })();
    try { await this.leaving; }
    finally { this.leaving = null; }
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
      const wasDismissed = this.dismissed;
      this.dismissed = false;
      this.restoredPresence = false;
      if (wasDismissed) await this.#saveDismissed(false);
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

  async #loadDismissed() {
    try {
      this.dismissed = JSON.parse(await readFile(this.stateFile, "utf8")).dismissed === true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async #saveDismissed(dismissed) {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ dismissed }), { mode: 0o600 });
    await rename(temp, this.stateFile);
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
