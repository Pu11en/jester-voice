import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";

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
    logFile = "logs/turns.jsonl", now = () => performance.now(), logger = console } = {}) {
    if (!worker || !brain || !voice || !ownerId) throw new Error("worker, brain, voice, and ownerId are required");
    this.worker = worker;
    this.brain = brain;
    this.voice = voice;
    this.ownerId = String(ownerId);
    this.presence = presence;
    this.transcript = transcript;
    this.stallClip = stallClip;
    this.logFile = logFile;
    this.now = now;
    this.logger = logger;
    this.started = false;
    this.turn = null;
    this.reply = null;
    this.replyNumber = 0;
    this.lastTimings = null;
    this.interrupting = Promise.resolve();
    this.onEvent = (event) => this.#event(event);
    this.onBrainThinking = (event) => this.#thinking(event);
    this.onBrainFirstWord = (event) => {
      if (this.turn && (!event.speaker || event.speaker === this.ownerId)) {
        this.turn.brainFirstWordAt ??= this.now();
      }
    };
    this.onPlayerState = (_oldState, newState) => {
      if (newState.status === "idle" && this.reply?.streamEnded) this.#finishReply();
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.worker.on("event", this.onEvent);
    this.brain.on("thinking", this.onBrainThinking);
    this.brain.on("firstWord", this.onBrainFirstWord);
    this.voice.player?.on("stateChange", this.onPlayerState);
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.worker.off("event", this.onEvent);
    this.brain.off("thinking", this.onBrainThinking);
    this.brain.off("firstWord", this.onBrainFirstWord);
    this.voice.player?.off("stateChange", this.onPlayerState);
    await this.#abortDraft();
    if (this.reply) this.#stopReply();
  }

  #event(event) {
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
    }
    if (this.turn && !this.turn.accepted) {
      const turn = this.turn;
      turn.resumed = true;
      turn.carriedText = mergeText(turn.carriedText || "", turn.pauseText);
      this.#interrupt("draft interrupt");
    }
  }

  async #turnEnd(event) {
    if (!event.text?.trim()) return;
    if (await this.presence?.handleOwnerTurn(event.text)) return;
    const text = this.turn?.resumed
      ? mergeText(this.turn.carriedText || this.turn.pauseText, event.text)
      : event.text.trim();
    if (this.turn && !this.turn.resumed && !this.turn.accepted) {
      this.turn.accepted = true;
      this.turn.finalText = text;
      this.turn.endAt = this.now();
      this.turn.utteranceMs = event.ms?.utterance ?? null;
      this.#releaseDraft(this.turn);
    } else {
      const previous = this.turn;
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
      this.#runDraft(this.turn, text);
    }
  }

  async #runDraft(turn, text) {
    try {
      await this.interrupting;
      if (this.turn !== turn || turn.resumed) return;
      for await (const sentence of this.brain.ask(text, { speaker: this.ownerId })) {
        if (this.turn !== turn || turn.resumed) return;
        turn.draftSentences.push(sentence);
        if (turn.accepted) this.#releaseDraft(turn);
      }
    } catch (error) {
      if (this.turn === turn && !turn.resumed) this.logger.warn?.("[conversation] brain:", error.message);
    } finally {
      turn.draftDone = true;
      if (this.turn === turn && turn.accepted) this.#releaseDraft(turn);
    }
  }

  #releaseDraft(turn) {
    if (this.turn !== turn || !turn.accepted || !turn.draftDone || turn.released) return;
    turn.released = true;
    const text = turn.draftSentences.join(" ").trim();
    if (!text) {
      this.turn = null;
      return;
    }
    turn.firstAudioAt = null;
    this.#speak(text, turn);
  }

  #speak(text, turn) {
    const id = `reply-${++this.replyNumber}`;
    const stream = new PassThrough();
    this.reply = { id, stream, text, turn, bytes: 0, streamEnded: false, startedAt: this.now() };
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

  #audioOut(event) {
    if (!this.reply || event.id !== this.reply.id) return;
    const pcm = Buffer.from(event.pcm, "base64");
    if (!this.reply.bytes) {
      this.reply.turn.firstAudioAt = this.now();
      this.lastTimings.endOfSpeechToFirstAudioMs = this.reply.turn.firstAudioAt - this.reply.turn.endAt;
      this.lastTimings.ttsFirstChunkMs = this.reply.turn.firstAudioAt - this.reply.startedAt;
    }
    this.reply.bytes += pcm.length;
    this.reply.stream.write(pcm);
  }

  #sayDone(event) {
    if (!this.reply || event.id !== this.reply.id) return;
    this.reply.streamEnded = true;
    this.reply.stream.end();
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
    if (this.turn === done.turn) this.turn = null;
  }

  #stopReply() {
    if (!this.reply) return;
    const reply = this.reply;
    this.reply = null;
    this.voice.stopNow();
    this.worker.send({ op: "cancel", id: reply.id });
    reply.stream.destroy();
  }

  #interrupt(label) {
    this.interrupting = Promise.resolve(this.brain.interrupt()).catch((error) => {
      this.logger.warn?.(`[conversation] ${label}:`, error.message);
    });
  }

  #thinking(event) {
    if (!this.stallClip || !this.turn || (event.speaker && event.speaker !== this.ownerId)) return;
    const id = `stall-${this.replyNumber}-${Date.now()}`;
    // The supplied PCM clip is cached by the caller and can play without waiting for TTS.
    this.voice.play(id, Buffer.from(this.stallClip));
  }

  async #abortDraft() {
    if (this.turn && !this.turn.accepted) await this.brain.interrupt().catch(() => {});
    this.turn = null;
  }

  async #log(entry) {
    try {
      await mkdir(dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      this.logger.warn?.("[conversation] turn log:", error.message);
    }
  }
}

export { heardWords, mergeText };
