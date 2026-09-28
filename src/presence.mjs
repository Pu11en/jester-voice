const LEAVE_PHRASE = /^\s*jester[\s,]+(?:leave|disconnect)\s*[.!?]*\s*$/i;

/** Auto-join and owner escape hatches for one configured Discord voice room. */
export class Presence {
  constructor({ client, voice, brain, config, transcript = null, logger = console } = {}) {
    if (!client || !voice || !brain || !config) {
      throw new Error("client, voice, brain, and config are required");
    }
    this.client = client;
    this.voice = voice;
    this.brain = brain;
    this.config = config;
    this.transcript = transcript;
    this.logger = logger;
    this.inPresence = false;
    this.dismissed = false;
    this.joined = false;
    this.joining = null;
    this.onVoiceState = (_oldState, newState) => this.#voiceState(newState);
    this.onMessage = (message) => this.#message(message);
    this.onVoiceDisconnect = () => { this.joined = false; this.#recoverVoice(); };
    this.recoveryAttempt = 0;
    this.recoveryTimer = null;
  }

  async start() {
    this.client.on("voiceStateUpdate", this.onVoiceState);
    this.client.on("messageCreate", this.onMessage);
    this.voice.on?.("disconnect", this.onVoiceDisconnect);
    try {
      await this.voice.login();
      const guild = this.client.guilds.cache.get(this.config.guildId);
      const owner = guild?.members.cache.get(this.config.ownerId);
      await this.#setPresence(owner?.voice?.channelId === this.config.voiceChannelId);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.closed = true;
    this.client.off("voiceStateUpdate", this.onVoiceState);
    this.client.off("messageCreate", this.onMessage);
    this.voice.off?.("disconnect", this.onVoiceDisconnect);
    clearTimeout(this.recoveryTimer);
  }

  /** Consume a clearly addressed owner voice command before it reaches Luna. */
  async handleOwnerTurn(text) {
    if (!LEAVE_PHRASE.test(text || "")) return false;
    await this.leave();
    return true;
  }

  async join() {
    if (!this.inPresence || this.joined || this.joining) return this.joining;
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
        await this.transcript?.start({ channel });
        await this.brain.prewarm();
      })
      .catch((error) => this.logger.warn?.("[presence] join:", error.message))
      .finally(() => { this.joining = null; });
    return this.joining;
  }

  async leave() {
    this.dismissed = true;
    clearTimeout(this.recoveryTimer);
    if (this.joining) await this.joining;
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
    if (message.author?.bot || String(message.author?.id) !== String(this.config.ownerId) ||
        message.guildId !== this.config.guildId || message.channelId !== this.config.transcriptChannelId) return;
    const command = message.content.trim().toLowerCase();
    if (command === "!jester leave") await this.leave();
    else if (command === "!jester join" && this.inPresence) await this.join();
  }

  #recoverVoice() {
    if (!this.inPresence || this.dismissed || this.closed || this.recoveryAttempt >= 5) return;
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const owner = guild?.members.cache.get(this.config.ownerId);
    if (owner?.voice?.channelId !== this.config.voiceChannelId) return;
    const delay = Math.min(5_000, 250 * (2 ** this.recoveryAttempt++));
    this.recoveryTimer = setTimeout(async () => {
      if (!this.inPresence || this.dismissed) return;
      const currentGuild = this.client.guilds.cache.get(this.config.guildId);
      const currentOwner = currentGuild?.members.cache.get(this.config.ownerId);
      if (currentOwner?.voice?.channelId !== this.config.voiceChannelId) return;
      await this.join();
      if (!this.joined) this.#recoverVoice();
      else this.recoveryAttempt = 0;
    }, delay);
    this.recoveryTimer.unref?.();
  }
}
