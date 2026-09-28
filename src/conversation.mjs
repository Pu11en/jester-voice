import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { appendBounded } from "./bounded-log.mjs";
import { Attention, modeCommand, possibleModeCommand } from "./attention.mjs";
import { parseOwnerIntent } from "./owner-intent.mjs";

const MAX_PENDING_TTS_BYTES = 8 * 1024 * 1024;
const MAX_TURN_LOG_BYTES = 10 * 1024 * 1024;
const THINKING_DELAY_MS = 2_500;

const heardWords = (text, playedMs) => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  // A conservative spoken pace keeps unheard tail words out of the context.
  return words.slice(0, Math.min(words.length, Math.floor(Math.max(0, playedMs) * 2.2 / 1000))).join(" ");
};

function mergeText(first, second) {
  const a = first.trim();
  const b = second.trim();
  if (!a) return b;
  if (!b) return a;
  const left = a.toLowerCase().replace(/[.,!?;:'"()[\]{}]/g, "").split(/\s+/);
  const right = b.toLowerCase().replace(/[.,!?;:'"()[\]{}]/g, "").split(/\s+/);
  for (let overlap = Math.min(left.length, right.length); overlap > 0; overlap -= 1) {
    if (left.slice(-overlap).join(" ") === right.slice(0, overlap).join(" ")) {
      return `${a} ${b.split(/\s+/).slice(overlap).join(" ")}`.trim();
    }
  }
  if (b.toLowerCase().startsWith(`${a.toLowerCase()} `)) return b;
  return `${a} ${b}`;
}

/**
 * Connects worker JSON events, the streaming brain client, and Discord voice.
 * Worker contract: send({op, ...}); emit parsed messages on `event`.
 */
export class Conversation {
  constructor({ worker, brain, voice, ownerId, presence = null, transcript = null, stallClip = null,
    unavailableClip = null, ownerRouter = null,
    logFile = "logs/turns.jsonl", now = () => performance.now(), logger = console } = {}) {
    if (!worker || !brain || !voice || !ownerId) throw new Error("worker, brain, voice, and ownerId are required");
    this.worker = worker;
    this.brain = brain;
    this.voice = voice;
    this.ownerId = String(ownerId);
    this.presence = presence;
    this.transcript = transcript;
    this.stallClip = stallClip;
    this.unavailableClip = unavailableClip;
    this.ownerRouter = ownerRouter;
    this.logFile = logFile;
    this.now = now;
    this.attention = new Attention(now);
    this.mode = "conversation";
    this.logger = logger;
    this.started = false;
    this.turn = null;
    this.reply = null;
    this.replyNumber = 0;
    this.turnNumber = 0;
    this.ownerSpeechVersion = 0;
    this.lastTimings = null;
    this.interrupting = Promise.resolve();
    this.logQueue = Promise.resolve();
    this.onEvent = (event) => this.#event(event);
    this.onWorkerFatal = (error) => this.#workerFailed(error);
    this.onVoiceDisconnect = () => this.#voiceDisconnected();
    this.onCapturePaused = (speakers) => {
      this.#voiceDisconnected();
      for (const speaker of speakers || []) {
        if (String(speaker) !== this.ownerId) this.worker.send({ op: "reset", speaker });
      }
    };
    this.onPresenceReset = (reason) => {
      if (reason === "owner_departed" || reason === "owner_leave") this.mode = "conversation";
      this.#voiceDisconnected();
    };
    this.onBrainFatal = (error) => {
      this.logger.warn?.("[conversation] brain unavailable:", error.message);
      if (this.turn && !this.turn.resumed) this.turn.brainFailed = true;
    };
    this.onBrainFirstWord = (event) => {
      if (this.turn && event.requestId === this.turn.requestId && !this.turn.resumed) {
        this.turn.brainFirstWordAt ??= this.now();
        this.#clearThinkingTimer(this.turn);
      }
    };
    this.onPlayerState = (_oldState, newState) => {
      if (newState.status === "idle") {
        this.#finishLocalClip();
        if (this.reply?.streamEnded) this.#finishReply();
      }
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.attention.reset();
    this.ownerRouter?.reset();
    void this.#refreshSessionTags();
    this.mode = "conversation";
    this.worker.on("event", this.onEvent);
    this.worker.on("fatal", this.onWorkerFatal);
    this.voice.on?.("disconnect", this.onVoiceDisconnect);
    this.presence?.on?.("reset", this.onPresenceReset);
    this.presence?.on?.("capturePaused", this.onCapturePaused);
    this.brain.on("firstWord", this.onBrainFirstWord);
    this.brain.on("fatal", this.onBrainFatal);
    this.voice.player?.on("stateChange", this.onPlayerState);
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.attention.reset();
    this.ownerRouter?.reset();
    this.mode = "conversation";
    this.ownerSpeechVersion += 1;
    this.worker.off("event", this.onEvent);
    this.worker.off("fatal", this.onWorkerFatal);
    this.voice.off?.("disconnect", this.onVoiceDisconnect);
    this.presence?.off?.("reset", this.onPresenceReset);
    this.presence?.off?.("capturePaused", this.onCapturePaused);
    this.brain.off("firstWord", this.onBrainFirstWord);
    this.brain.off("fatal", this.onBrainFatal);
    this.voice.player?.off("stateChange", this.onPlayerState);
    await this.#abortDraft();
    if (this.reply) this.#stopReply();
    this.#stopLocalClip();
  }

  #event(event) {
    if (this.presence?.paused) return;
    if (event?.ev === "audio_out") return this.#audioOut(event);
    if (event?.ev === "say_done") return this.#sayDone(event);
    if (event?.ev === "turn_end" && event.text?.trim()) {
      void this.transcript?.record(this.voice.displayName?.(event.speaker) || event.speaker, event.text);
    }
    if (event?.speaker !== this.ownerId) return;
    if (event.ev === "pause") this.#pause(event);
    else if (event.ev === "speech_start") this.#speechStart();
    else if (event.ev === "turn_end") this.#turnEnd(event);
  }

  #pause(event) {
    if (this.turn || !(event.prob > 0.3) || !event.text?.trim()) return;
    if (this.mode === "transcript" || possibleModeCommand(event.text)) return;
    // Waking requires a completed owner turn; a tentative name must not open
    // the gate, send room speech to Luna, or bypass deterministic controls.
    if (!this.attention.engaged || this.attention.classify(event.text) !== "conversation") return;
    this.turn = {
      pauseText: event.text.trim(),
      resumed: false,
      accepted: false,
      draftDone: false,
      draftSentences: [],
      startedAt: this.now(),
      pauseAt: this.now(),
      sttMs: event.ms?.stt ?? null,
      brainFirstWordAt: null,
    };
    this.#runDraft(this.turn, event.text.trim());
  }

  #speechStart() {
    this.ownerSpeechVersion += 1;
    this.#cancelThinking();
    this.#stopLocalClip();
    if (this.reply) {
      const reply = this.reply;
      const stopStarted = this.now();
      this.#stopReply();
      this.#interrupt("interrupt");
      const heard = heardWords(reply.text, this.voice.playedMs(reply.id));
      if (heard) void this.transcript?.record("Jester", heard);
      if (heard) this.brain.injectContext(`Jester said (heard): ${heard}`);
      const bargeStopMs = this.now() - stopStarted;
      if (this.lastTimings) this.lastTimings.bargeInStopMs = bargeStopMs;
      void this.#log({ type: "barge_in", heard, bargeStopMs,
        timings: this.lastTimings ? { ...this.lastTimings } : null });
      this.turn = null;
    } else if (this.turn?.accepted) {
      this.turn = null;
      this.#interrupt("accepted turn interrupt");
    }
    this.worker.dropQueuedAudio?.(this.ownerId, 24);
    if (this.turn && !this.turn.accepted) {
      const turn = this.turn;
      turn.resumed = true;
      turn.carriedText = mergeText(turn.carriedText || "", turn.pauseText);
      this.#interrupt("draft interrupt");
    }
  }

  async #turnEnd(event) {
    if (!event.text?.trim()) return;
    const speechVersion = this.ownerSpeechVersion;
    if (await this.presence?.handleOwnerTurn(event.text)) {
      this.attention.reset();
      this.ownerRouter?.reset();
      await this.#abortDraft();
      return;
    }
    if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
    const requestedMode = modeCommand(event.text);
    if (requestedMode) {
      this.mode = requestedMode;
      this.transcript?.setMode?.(requestedMode);
      this.attention.reset();
      this.ownerRouter?.reset();
      if (this.reply) this.#stopReply();
      this.#stopLocalClip();
      await this.#abortDraft();
      return;
    }
    if (this.mode === "transcript") {
      await this.#abortDraft();
      return;
    }
    // Classify the final utterance itself: carried draft words must not hide an
    // ending/side address or reuse an old wake name after the window expires.
    const wasEngaged = this.attention.engaged;
    if (this.attention.classify(event.text) === "ambient" && wasEngaged &&
      /^[\p{L}][\p{L}'-]*\s*[,;:—–-]/u.test(event.text.trim())) {
      await this.#refreshSessionTags();
      if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
    }
    if (!this.attention.accept(event.text)) {
      if (!this.attention.engaged) this.ownerRouter?.reset();
      if (this.reply) this.#stopReply();
      this.#stopLocalClip();
      await this.#abortDraft();
      return;
    }
    const text = this.turn?.resumed
      ? mergeText(this.turn.carriedText || this.turn.pauseText, event.text)
      : event.text.trim();
    if (this.ownerRouter && parseOwnerIntent(text)) {
      await this.#abortDraft();
      const intent = parseOwnerIntent(text);
      if (intent?.kind === "message" || intent?.kind === "stop") {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
      let response;
      try {
        response = await this.ownerRouter.handle(text, {
          speakerId: this.ownerId, allowReference: wasEngaged,
        });
      } catch (error) {
        this.logger.warn?.("[conversation] owner route:", error.message);
        response = "I can't reach the session list right now. Please try again.";
      }
      if (response && this.started && speechVersion === this.ownerSpeechVersion) {
        this.#speakControl(response, event);
      }
      return;
    }
    if (this.turn && !this.turn.resumed && !this.turn.accepted) {
      this.turn.accepted = true;
      this.turn.finalText = text;
      this.turn.endAt = this.now();
      this.turn.utteranceMs = event.ms?.utterance ?? null;
      this.#scheduleThinking(this.turn);
      this.#releaseDraft(this.turn);
    } else {
      const previous = this.turn;
      this.#cancelThinking();
      this.turn = {
        finalText: text,
        accepted: true,
        startedAt: this.now(),
        endAt: this.now(),
        sttMs: previous?.sttMs ?? null,
        utteranceMs: event.ms?.utterance ?? null,
        brainFirstWordAt: null,
        draftDone: false,
        draftSentences: [],
      };
      this.#scheduleThinking(this.turn);
      this.#runDraft(this.turn, text);
    }
  }

  async #runDraft(turn, text) {
    turn.requestId = `voice-turn-${++this.turnNumber}`;
    try {
      await this.interrupting;
      if (this.turn !== turn || turn.resumed) return;
      for await (const sentence of this.brain.ask(text, { speaker: this.ownerId, requestId: turn.requestId })) {
        if (this.turn !== turn || turn.resumed) return;
        // A completed sentence also proves words arrived, even for a brain adapter
        // that does not emit firstWord events.
        turn.brainFirstWordAt ??= this.now();
        this.#clearThinkingTimer(turn);
        turn.draftSentences.push(sentence);
        if (turn.accepted) this.#releaseDraft(turn);
      }
    } catch (error) {
      if (this.turn === turn && !turn.resumed) {
        turn.brainFailed = true;
        this.logger.warn?.("[conversation] brain:", error.message);
      }
    } finally {
      turn.draftDone = true;
      this.#clearThinkingTimer(turn);
      if (this.turn === turn && turn.accepted) this.#releaseDraft(turn);
    }
  }

  #releaseDraft(turn) {
    if (this.turn !== turn || !turn.accepted) return;
    turn.releasedCount ??= 0;
    while (turn.releasedCount < turn.draftSentences.length) {
      const sentence = turn.draftSentences[turn.releasedCount++];
      if (this.reply?.turn === turn) {
        this.reply.queue.push(sentence);
        if (!this.reply.activeSayId) this.#sayNext();
      } else {
        turn.firstAudioAt = null;
        this.#speak(sentence, turn);
      }
    }
    if (turn.draftDone) {
      if (this.reply?.turn === turn) {
        this.reply.brainDone = true;
        if (!this.reply.activeSayId) this.#sayNext();
      } else if (turn.brainFailed && !turn.releasedCount) {
        if (!this.#playUnavailable(turn)) this.turn = null;
      } else {
        this.#cancelThinking(turn);
        this.turn = null;
      }
    }
  }

  #speak(text, turn) {
    this.#cancelThinking(turn);
    const id = `reply-${++this.replyNumber}`;
    const stream = new PassThrough();
    this.reply = { id, activeSayId: id, stream, text, queue: [], brainDone: false,
      turn, bytes: 0, streamEnded: false, startedAt: this.now() };
    this.lastTimings = {
      endOfSpeechToFirstAudioMs: null,
      sttMs: turn.sttMs,
      brainFirstWordMs: turn.brainFirstWordAt === null ? null : turn.brainFirstWordAt - turn.endAt,
      ttsFirstChunkMs: null,
      bargeInStopMs: null,
    };
    this.worker.send({ op: "say", id, text });
    this.voice.play(id, stream);
  }

  #speakControl(text, event) {
    const turn = {
      accepted: true, draftDone: true, endAt: this.now(),
      sttMs: event.ms?.stt ?? null, utteranceMs: event.ms?.utterance ?? null,
      brainFirstWordAt: this.now(),
    };
    this.turn = turn;
    this.#speak(text, turn);
    this.reply.brainDone = true;
  }

  #audioOut(event) {
    if (!this.reply || event.id !== this.reply.activeSayId) return;
    const pcm = Buffer.from(event.pcm, "base64");
    if (!this.reply.bytes) {
      this.reply.turn.firstAudioAt = this.now();
      this.lastTimings.endOfSpeechToFirstAudioMs = this.reply.turn.firstAudioAt - this.reply.turn.endAt;
      this.lastTimings.ttsFirstChunkMs = this.reply.turn.firstAudioAt - this.reply.startedAt;
    }
    this.reply.bytes += pcm.length;
    if (this.reply.bytes - this.voice.playedMs(this.reply.id) * 192 > MAX_PENDING_TTS_BYTES) {
      this.logger.warn?.("[conversation] dropping TTS reply after output backlog exceeded limit");
      this.#stopReply();
      void this.#interrupt("TTS backlog interrupt");
      this.turn = null;
      return;
    }
    this.reply.stream.write(pcm);
  }

  #sayDone(event) {
    if (!this.reply || event.id !== this.reply.activeSayId) return;
    this.reply.activeSayId = null;
    this.#sayNext();
  }

  #sayNext() {
    if (!this.reply || this.reply.activeSayId) return;
    const sentence = this.reply.queue.shift();
    if (sentence) {
      const id = `reply-${++this.replyNumber}`;
      this.reply.activeSayId = id;
      this.reply.text += ` ${sentence}`;
      this.worker.send({ op: "say", id, text: sentence });
    } else if (this.reply.brainDone) {
      this.reply.streamEnded = true;
      this.reply.stream.end();
    }
  }

  #finishReply() {
    if (!this.reply?.streamEnded) return;
    const done = this.reply;
    this.reply = null;
    const heard = heardWords(done.text, this.voice.playedMs(done.id));
    if (heard) void this.transcript?.record("Jester", heard);
    void this.#log({
      type: "turn",
      heardText: heard,
      timings: this.lastTimings,
      sttMs: done.turn.sttMs,
      utteranceMs: done.turn.utteranceMs,
    });
    if (this.turn === done.turn) {
      // Give Drew a full follow-up window after even a long spoken answer.
      this.attention.refresh();
      if (!done.turn.brainFailed || !this.#playUnavailable(done.turn)) this.turn = null;
    }
  }

  #stopReply() {
    if (!this.reply) return;
    const reply = this.reply;
    this.reply = null;
    this.voice.stopNow();
    if (reply.activeSayId) this.worker.send({ op: "cancel", id: reply.activeSayId });
    reply.stream.destroy();
  }

  #workerFailed(error) {
    this.logger.warn?.("[conversation] speech worker restarted after failure:", error.message);
    this.#cancelThinking();
    if (this.reply) this.#stopReply();
    this.turn = null;
    this.#interrupt("worker failure");
  }

  #playUnavailable(turn) {
    if (this.turn !== turn || !turn.accepted || turn.unavailablePlayed || !this.unavailableClip) return false;
    turn.unavailablePlayed = true;
    this.#cancelThinking(turn);
    this.turn = null;
    const message = "I can't reach Luna right now. My voice controls still work.";
    const id = `unavailable-${++this.replyNumber}`;
    this.localClipId = id;
    this.localClipText = message;
    this.voice.play(id, Buffer.from(this.unavailableClip));
    return true;
  }

  #finishLocalClip() {
    if (!this.localClipId) return;
    const message = this.localClipText;
    this.localClipId = null;
    this.localClipText = null;
    if (message) void this.transcript?.record("Jester", message);
  }

  #stopLocalClip() {
    if (!this.localClipId) return;
    const heard = heardWords(this.localClipText, this.voice.playedMs(this.localClipId));
    this.localClipId = null;
    this.localClipText = null;
    this.voice.stopNow();
    if (heard) void this.transcript?.record("Jester", heard);
  }

  #voiceDisconnected() {
    this.attention.reset();
    this.ownerRouter?.reset();
    this.ownerSpeechVersion += 1;
    this.#stopLocalClip();
    this.#cancelThinking();
    if (this.reply) this.#stopReply();
    this.worker.dropQueuedAudio?.(this.ownerId, 0);
    this.worker.send({ op: "reset", speaker: this.ownerId });
    this.turn = null;
    this.#interrupt("voice disconnect");
  }

  #interrupt(label) {
    this.interrupting = Promise.resolve(this.brain.interrupt()).catch((error) => {
      this.logger.warn?.(`[conversation] ${label}:`, error.message);
    });
  }

  async #refreshSessionTags() {
    if (!this.ownerRouter) return;
    try { this.attention.setSessionTags(await this.ownerRouter.sessionTags()); }
    catch (error) { this.logger.warn?.("[conversation] session tags:", error.message); }
  }

  #scheduleThinking(turn) {
    if (!this.stallClip || !turn.accepted || turn.resumed || turn.draftDone ||
      turn.brainFirstWordAt !== null || turn.cuePlayed || turn.thinkingTimer) return;
    turn.thinkingTimer = setTimeout(() => {
      turn.thinkingTimer = null;
      if (!this.started || this.turn !== turn || !turn.accepted || turn.resumed ||
        turn.draftDone || turn.brainFirstWordAt !== null || turn.cuePlayed || this.reply) return;
      // Count only time since acceptance, never time spent speculating during a pause.
      if (this.now() - turn.endAt < THINKING_DELAY_MS) {
        this.#scheduleThinking(turn);
        return;
      }
      turn.cuePlayed = true;
      turn.cueId = `stall-${turn.requestId}`;
      this.voice.play(turn.cueId, Buffer.from(this.stallClip));
    }, Math.max(1, THINKING_DELAY_MS - (this.now() - turn.endAt)));
    turn.thinkingTimer.unref?.();
  }

  #clearThinkingTimer(turn) {
    if (!turn) return;
    clearTimeout(turn.thinkingTimer);
    turn.thinkingTimer = null;
  }

  #cancelThinking(turn = this.turn) {
    this.#clearThinkingTimer(turn);
    if (turn?.cueId) {
      turn.cueId = null;
      this.voice.stopNow();
    }
  }

  async #abortDraft() {
    this.#cancelThinking();
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      this.#interrupt("discard turn");
      await this.interrupting;
    }
  }

  async #log(entry) {
    this.logQueue = this.logQueue.then(async () => {
      try {
        await mkdir(dirname(this.logFile), { recursive: true });
        await appendBounded(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, MAX_TURN_LOG_BYTES);
      } catch (error) {
        this.logger.warn?.("[conversation] turn log:", error.message);
      }
    });
    return this.logQueue;
  }
}

export { heardWords, mergeText };
