import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { appendBounded } from "./bounded-log.mjs";
import { Attention, modeCommand, possibleModeCommand } from "./attention.mjs";
import { parseOwnerIntent, isSessionReadFollowUp } from "./owner-intent.mjs";
import { CreateDraft } from "./create-draft.mjs";
import { BRAIN_OUT_LINE } from "./owner-router.mjs";

const OUTAGE_REASONS = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded",
  "unreachable", "authFailed", "billing", "timeout"]);
import { isAffirmative, isBackchannelOnly, isNegative, isStopSpeech, stripLeadingBackchannel }
  from "./backchannel.mjs";

const MAX_PENDING_TTS_BYTES = 8 * 1024 * 1024;
const MAX_TURN_LOG_BYTES = 10 * 1024 * 1024;
const THINKING_DELAY_MS = 2_500;
// A bare yes/no counts as an answer only this soon after Jester's reply ended with "?".
const ANSWER_WINDOW_MS = 8_000;
const STATUS_KINDS = ["status-one", "status-last", "session-discuss"];
const METRIC_KEYS = ["voiced_ms", "vad_mean", "stt_logprob"];

const sameWords = (a, b) => {
  const norm = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/).filter(Boolean).join(" ");
  return norm(a) === norm(b);
};

/** The owner's words plus any worker speech metrics present on the event, for turn rows. */
function ownerFacts(text, event = {}) {
  const facts = { ownerText: text?.trim() || null };
  for (const key of METRIC_KEYS) if (event[key] !== undefined) facts[key] = event[key];
  return facts;
}

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
    unavailableClip = null, ownerRouter = null, intentProposer = null,
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
    this.intentProposer = intentProposer;
    this.logFile = logFile;
    this.now = now;
    this.attention = new Attention(now);
    this.createDraft = new CreateDraft();
    this.mode = "conversation";
    this.logger = logger;
    this.started = false;
    this.turn = null;
    this.reply = null;
    this.replyNumber = 0;
    this.turnNumber = 0;
    this.ownerSpeechVersion = 0;
    this.ownerSpeaking = false;
    this.ownerAudioIncomplete = false;
    this.lastTimings = null;
    this.questionEndedAt = null;
    this.interrupting = Promise.resolve();
    this.logQueue = Promise.resolve();
    this.onEvent = (event) => this.#event(event);
    this.onWorkerFatal = (error) => this.#workerFailed(error);
    this.onWorkerDrop = (event) => {
      if (String(event.speaker) === this.ownerId) this.ownerAudioIncomplete = true;
    };
    this.onVoiceDisconnect = () => this.#voiceDisconnected();
    this.onCapturePaused = (speakers) => {
      this.#voiceDisconnected();
      for (const speaker of speakers || []) {
        if (String(speaker) !== this.ownerId) this.worker.send({ op: "reset", speaker });
      }
    };
    this.onPresenceReset = (reason) => {
      if (reason === "owner_departed" || reason === "owner_leave") this.mode = "conversation";
      if (!reason) this.voice.setSelfMuted?.(this.mode === "transcript");
      this.#voiceDisconnected();
    };
    this.onRestoredPresence = () => {
      this.mode = "transcript";
      this.attention.reset();
      this.createDraft.reset();
      this.ownerRouter?.reset();
      this.voice.setSelfMuted?.(true);
    };
    this.onBrainFatal = (error) => {
      this.logger.warn?.("[conversation] brain unavailable:", error.message);
      if (this.turn && !this.turn.resumed) {
        this.turn.brainFailed = true;
        if (error?.reason) this.turn.brainError ??= { reason: error.reason, brain: error.brain ?? null };
      }
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
    this.createDraft.reset();
    this.ownerRouter?.reset();
    void this.#refreshSessionTags();
    this.mode = "conversation";
    this.worker.on("event", this.onEvent);
    this.worker.on("fatal", this.onWorkerFatal);
    this.worker.on("drop", this.onWorkerDrop);
    this.voice.on?.("disconnect", this.onVoiceDisconnect);
    this.presence?.on?.("reset", this.onPresenceReset);
    this.presence?.on?.("restoredPresence", this.onRestoredPresence);
    this.presence?.on?.("capturePaused", this.onCapturePaused);
    this.brain.on("firstWord", this.onBrainFirstWord);
    this.brain.on("fatal", this.onBrainFatal);
    this.voice.player?.on("stateChange", this.onPlayerState);
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.attention.reset();
    this.createDraft.reset();
    this.ownerRouter?.reset();
    this.mode = "conversation";
    this.ownerSpeechVersion += 1;
    this.ownerSpeaking = false;
    this.worker.off("event", this.onEvent);
    this.worker.off("fatal", this.onWorkerFatal);
    this.worker.off("drop", this.onWorkerDrop);
    this.voice.off?.("disconnect", this.onVoiceDisconnect);
    this.presence?.off?.("reset", this.onPresenceReset);
    this.presence?.off?.("restoredPresence", this.onRestoredPresence);
    this.presence?.off?.("capturePaused", this.onCapturePaused);
    this.brain.off("firstWord", this.onBrainFirstWord);
    this.brain.off("fatal", this.onBrainFatal);
    this.voice.player?.off("stateChange", this.onPlayerState);
    await this.#abortDraft();
    if (this.reply) this.#stopReply();
    this.#stopLocalClip();
    await this.logQueue;
  }

  #event(event) {
    if (this.presence?.paused) return;
    if (event?.ev === "audio_out") return this.#audioOut(event);
    if (event?.ev === "say_done") return this.#sayDone(event);
    if (event?.ev === "turn_end" && event.text?.trim()) {
      if (this.#ignoredBackchannel(event)) {
        // Listening sounds are neither a stop nor a turn, and never reach the room log.
        if (event.speaker === this.ownerId) this.ownerSpeaking = false;
        void this.#log({ type: "backchannel_ignored", text: event.text.trim(),
          speaker: String(event.speaker) });
        return;
      }
      void this.transcript?.record(this.voice.displayName?.(event.speaker) || event.speaker, event.text);
    }
    if (event?.speaker !== this.ownerId) {
      // A second person's speech ends the owner's active exchange. Their
      // words remain in the room transcript but never reach Luna or EBI.
      if (event?.ev === "speech_start" || event?.ev === "turn_end") {
        this.ownerSpeechVersion += 1;
        this.attention.reset();
        this.ownerRouter?.reset();
        this.createDraft.reset();
        if (this.reply) this.#stopReply();
        this.#stopLocalClip();
        void this.#abortDraft();
      }
      return;
    }
    if (event.ev === "pause") this.#pause(event);
    else if (event.ev === "speech_start") this.#speechStart();
    else if (event.ev === "speech_sustained") this.#ownerWords("sustained");
    else if (event.ev === "turn_end") this.#turnEnd(event);
  }

  /** Backchannel-only speech to drop, unless it is a bare yes/no answering Jester's question. */
  #ignoredBackchannel(event) {
    if (!isBackchannelOnly(event.text)) return false;
    if (String(event.speaker) !== this.ownerId) return true;
    if (event.incomplete || this.ownerAudioIncomplete) return false;
    const answering = this.questionEndedAt !== null &&
      this.now() - this.questionEndedAt <= ANSWER_WINDOW_MS;
    return !(answering && (isAffirmative(event.text) || isNegative(event.text)));
  }

  #pause(event) {
    const text = event.text?.trim();
    if (!text || isBackchannelOnly(text)) return;
    if (this.turn && !this.turn.accepted && !this.turn.resumed && sameWords(this.turn.pauseText, text)) return;
    // Recognised words, not a bare voice onset, stop Jester and invalidate stale work.
    this.#ownerWords("words");
    if (isStopSpeech(text)) return;
    if (event.incomplete || this.ownerAudioIncomplete) return;
    if (this.turn || !(event.prob > 0.3)) return;
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
    // A voice onset alone may be a cough, breath or hum: it never stops Jester.
    this.ownerSpeaking = true;
    this.worker.dropQueuedAudio?.(this.ownerId, 24);
  }

  /** The owner is really talking: stop Jester, drop accepted brain work, resume a draft. */
  #ownerWords(source) {
    this.ownerSpeechVersion += 1;
    this.ownerSpeaking = true;
    void this.intentProposer?.interrupt?.().catch?.(() => {});
    this.#cancelThinking();
    this.#stopLocalClip();
    if (this.reply) {
      this.#bargeIn(source);
      this.turn = null;
    } else if (this.turn?.accepted) {
      this.turn = null;
      this.#interrupt("accepted turn interrupt");
    }
    if (this.turn && !this.turn.accepted) this.#resumeDraft(this.turn, true);
  }

  #resumeDraft(turn, interrupt) {
    if (!turn.resumed) {
      turn.resumed = true;
      turn.carriedText = mergeText(turn.carriedText || "", turn.pauseText);
    }
    if (interrupt && !turn.interrupted) {
      turn.interrupted = true;
      this.#interrupt("draft interrupt");
    }
  }

  /** Stop the playing reply, keep only the words Drew heard, and interrupt the brain. */
  #bargeIn(source) {
    const reply = this.reply;
    const stopStarted = this.now();
    this.#stopReply();
    this.#interrupt("interrupt");
    const heard = heardWords(reply.text, this.voice.playedMs(reply.id));
    if (heard && !isBackchannelOnly(heard)) {
      void this.transcript?.record("Jester", heard);
      this.brain.injectContext(`Jester said (heard): ${heard}`);
    }
    const bargeStopMs = this.now() - stopStarted;
    if (this.lastTimings) this.lastTimings.bargeInStopMs = bargeStopMs;
    void this.#log({ type: "barge_in", source, heard, bargeStopMs,
      timings: this.lastTimings ? { ...this.lastTimings } : null });
  }

  async #turnEnd(event) {
    this.ownerSpeaking = false;
    if (event.incomplete || this.ownerAudioIncomplete) {
      const wasAddressed = this.attention.engaged ||
        /^(?:(?:hey|hi|hello|okay|ok|yo)\s+)?jester\b/iu.test(event.text?.trim() || "");
      this.ownerAudioIncomplete = false;
      this.ownerSpeechVersion += 1;
      this.attention.reset();
      this.ownerRouter?.reset();
      this.createDraft.reset();
      await this.#abortDraft();
      if (wasAddressed && this.started && this.mode === "conversation" && event.text?.trim()) {
        this.#speakControl("I missed part of that. Please say Jester and repeat it.", event);
        this.turn.noRefresh = true;
      }
      return;
    }
    if (!event.text?.trim()) return;
    // Real words decide: stop Jester and any accepted brain work before this turn runs.
    this.ownerSpeechVersion += 1;
    this.#cancelThinking();
    this.#stopLocalClip();
    if (this.reply) {
      this.#bargeIn("turn_end");
      this.turn = null;
    } else if (this.turn?.accepted) {
      this.turn = null;
      this.#interrupt("accepted turn interrupt");
    }
    if (this.turn && !this.turn.accepted && !sameWords(this.turn.pauseText, event.text)) {
      this.#resumeDraft(this.turn, false);
    }
    if (isStopSpeech(event.text)) {
      // A bare stop never reaches Luna or EBI; the exchange stays open.
      await this.#abortDraft();
      void this.#log({ type: "stop_speech", text: event.text.trim() });
      return;
    }
    const speechVersion = this.ownerSpeechVersion;
    if (await this.presence?.handleOwnerTurn(event.text,
      { allowBareDisconnect: this.attention.engaged })) {
      this.attention.reset();
      this.ownerRouter?.reset();
      this.createDraft.reset();
      await this.#abortDraft();
      return;
    }
    if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
    const requestedMode = modeCommand(event.text);
    if (requestedMode) {
      this.mode = requestedMode;
      if (requestedMode === "conversation") this.presence?.clearRestoredPresence?.();
      this.voice.setSelfMuted?.(requestedMode === "transcript");
      if (requestedMode === "transcript") await this.ownerRouter?.dependencies?.cancelPending?.();
      this.transcript?.setMode?.(requestedMode);
      this.attention.reset();
      this.ownerRouter?.reset();
      this.createDraft.reset();
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
    const maybeDirectTag = /^(?:and\s+)?[\p{L}][\p{L}'-]*\s*[,;:!?—–-]/iu.test(event.text.trim());
    if (wasEngaged && maybeDirectTag) {
      // A new session's name must be addressable before this turn is parsed.
      await this.#refreshSessionTags();
      if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
    } else if (wasEngaged) {
      void this.#refreshSessionTags();
    }
    if (!this.attention.accept(event.text)) {
      this.ownerSpeechVersion += 1;
      if (!this.attention.engaged) {
        this.ownerRouter?.reset();
        this.createDraft.reset();
      }
      if (this.reply) this.#stopReply();
      this.#stopLocalClip();
      await this.#abortDraft();
      return;
    }
    if (!wasEngaged) this.createDraft.reset();
    const text = this.turn?.resumed
      ? mergeText(this.turn.carriedText || this.turn.pauseText, event.text)
      : event.text.trim();
    const create = this.ownerRouter ? this.createDraft.consume(text) : { handled: false };
    if (create.handled) {
      await this.#abortDraft();
      if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
      if (!create.project) {
        this.#speakControl(create.reply, event);
        return;
      }
      // A complete draft is routed through the same checked project resolver
      // and spawn receipt path as a one-turn request.
      await new Promise(resolve => setTimeout(resolve, 800));
      if (!this.started || speechVersion !== this.ownerSpeechVersion || this.mode !== "conversation") return;
      let response;
      try {
        response = await this.ownerRouter.handle(text, {
          speakerId: this.ownerId,
          intent: { kind: "create", project: create.project, instruction: create.instruction,
            runtime: null, model: null },
          shouldAct: () => this.started && speechVersion === this.ownerSpeechVersion &&
            this.attention.engaged && this.mode === "conversation" && !this.presence?.paused,
        });
      } catch (error) {
        this.logger.warn?.("[conversation] owner route:", error.message);
        response = "I can't reach the session list right now. Please try again.";
      }
      void this.#refreshSessionTags();
      if (response && this.started && speechVersion === this.ownerSpeechVersion) this.#speakControl(response, event);
      return;
    }
    let intent = this.ownerRouter ?
      parseOwnerIntent(text, { knownTags: this.attention.sessionTags }) ||
      (wasEngaged && this.ownerRouter.hasReadContext?.() && isSessionReadFollowUp(text) ?
        { kind: "session-discuss", target: "it" } : null) : null;
    if (!intent && this.ownerRouter && this.intentProposer?.likelyWork(text,
      [...this.attention.sessionTags])) {
      intent = await this.intentProposer.propose(text, [...this.attention.sessionTags]);
      if (!this.started || speechVersion !== this.ownerSpeechVersion ||
          this.mode !== "conversation") return;
    }
    if (intent) {
      void this.#log({ type: "owner_intent", kind: intent.kind,
        target: intent.target || intent.project || null,
        reason: intent.reason || null, speaker: this.ownerId });
      this.createDraft.reset();
      await this.#abortDraft();
      if (["message", "stop", "close", "runtime", "create", "dependency", "dependency-group", "result-watch"].includes(intent.kind)) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      if (!this.started || speechVersion !== this.ownerSpeechVersion) return;
      if (STATUS_KINDS.includes(intent.kind) && this.ownerRouter.readContext) {
        let read;
        try {
          read = await this.ownerRouter.readContext(intent, { allowReference: wasEngaged });
        } catch (error) {
          this.logger.warn?.("[conversation] session read:", error.message);
          read = { kind: "answer", text: "I can't read that session right now. Please try again." };
        }
        if (!this.started || speechVersion !== this.ownerSpeechVersion || this.mode !== "conversation") return;
        if (read.kind === "answer") this.#speakControl(read.text, event);
        else {
          const turn = {
            finalText: text, accepted: true, startedAt: this.now(), endAt: this.now(),
            sttMs: event.ms?.stt ?? null, utteranceMs: event.ms?.utterance ?? null,
            brainFirstWordAt: null, draftDone: false, draftSentences: [],
            intent, allowReference: wasEngaged, facts: ownerFacts(text, event),
          };
          this.turn = turn;
          this.#scheduleThinking(turn);
          this.#runDraft(turn, text, read.text);
        }
        return;
      }
      let response;
      try {
        response = await this.ownerRouter.handle(text, {
          speakerId: this.ownerId, allowReference: wasEngaged, intent,
          shouldAct: () => this.started && speechVersion === this.ownerSpeechVersion &&
            this.attention.engaged && this.mode === "conversation" && !this.presence?.paused,
        });
      } catch (error) {
        this.logger.warn?.("[conversation] owner route:", error.message);
        response = "I can't reach the session list right now. Please try again.";
      }
      if (intent.kind === "create") void this.#refreshSessionTags();
      if (response && this.started && speechVersion === this.ownerSpeechVersion) {
        if (STATUS_KINDS.includes(intent.kind)) {
          this.brain.injectContext?.(`Verified EBI session context: ${response}`);
        }
        this.#speakControl(response, event);
      }
      return;
    }
    if (this.turn && !this.turn.resumed && !this.turn.accepted) {
      this.turn.accepted = true;
      this.turn.finalText = text;
      this.turn.facts = ownerFacts(text, event);
      this.turn.endAt = this.now();
      this.turn.utteranceMs = event.ms?.utterance ?? null;
      this.#scheduleThinking(this.turn);
      this.#releaseDraft(this.turn);
    } else {
      const previous = this.turn;
      this.#cancelThinking();
      if (previous?.resumed && !previous.interrupted) this.#resumeDraft(previous, true);
      this.turn = {
        finalText: text,
        facts: ownerFacts(text, event),
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

  /** An interrupted turn can still be winding down; wait for it once instead of failing. */
  async *#ask(text, options) {
    try {
      yield* this.brain.ask(text, options);
    } catch (error) {
      if (error?.reason !== "busy") throw error;
      try { await this.brain.interrupt?.(); } catch { /* the retry reports its own failure */ }
      await new Promise(resolve => setTimeout(resolve, 500));
      yield* this.brain.ask(text, options);
    }
  }

  async #runDraft(turn, text, context = null) {
    turn.requestId = `voice-turn-${++this.turnNumber}`;
    try {
      await this.interrupting;
      if (this.turn !== turn || turn.resumed) return;
      for await (const sentence of this.#ask(text, { speaker: this.ownerId,
        requestId: turn.requestId, context })) {
        if (this.turn !== turn || turn.resumed) return;
        // A completed sentence also proves words arrived, even for a brain adapter
        // that does not emit firstWord events.
        turn.brainFirstWordAt ??= this.now();
        this.#clearThinkingTimer(turn);
        // Jester never says a filler, and never opens a sentence with one.
        const spoken = stripLeadingBackchannel(sentence).trim();
        if (!spoken) continue;
        turn.draftSentences.push(spoken);
        if (turn.accepted) this.#releaseDraft(turn);
      }
    } catch (error) {
      if (this.turn === turn && !turn.resumed) {
        turn.brainFailed = true;
        if (error?.reason) turn.brainError = { reason: error.reason, brain: error.brain ?? null };
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
        if (!this.#brainOut(turn)) this.turn = null;
      } else {
        this.#cancelThinking(turn);
        this.turn = null;
      }
    }
  }

  #speak(text, turn) {
    this.#cancelThinking(turn);
    // Never orphan a reply that is still playing.
    if (this.reply) this.#stopReply();
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
      accepted: true, draftDone: true, endAt: this.now(), facts: ownerFacts(event.text, event),
      sttMs: event.ms?.stt ?? null, utteranceMs: event.ms?.utterance ?? null,
      brainFirstWordAt: this.now(),
    };
    this.turn = turn;
    this.#speak(text, turn);
    this.reply.brainDone = true;
  }

  /** Speak a checked background update only during a quiet conversation gap. */
  announce(text) {
    if (!this.started || this.mode !== "conversation" || this.ownerSpeaking ||
        this.turn || this.reply || this.localClipId || this.presence?.paused) return false;
    this.#speakControl(text, { ms: {} });
    this.turn.noRefresh = true;
    return true;
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
    // The reply played to its end, so every word was said; the estimate is for cut-off replies.
    const heard = done.text.trim();
    if (heard) void this.transcript?.record("Jester", heard);
    this.questionEndedAt = done.text.trim().endsWith("?") ? this.now() : null;
    void this.#log({
      type: "turn",
      ...(done.turn.facts || { ownerText: null }),
      heardText: heard,
      timings: this.lastTimings,
      sttMs: done.turn.sttMs,
      utteranceMs: done.turn.utteranceMs,
    });
    if (this.turn === done.turn) {
      // Give Drew a full follow-up window after even a long spoken answer.
      if (!done.turn.noRefresh) this.attention.refresh();
      if (!done.turn.brainFailed || !this.#brainOut(done.turn)) this.turn = null;
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

  /** On a detected brain failure, speak the honest line (or a status sentence) once. */
  #brainOut(turn) {
    if (this.turn !== turn || !turn.accepted || !turn.brainError || turn.brainOutSpoken) return false;
    turn.brainOutSpoken = true;
    this.#cancelThinking(turn);
    this.turn = null;
    const { reason, brain } = turn.brainError;
    void this.#log({ type: "brain_error", reason, brain });
    const speechVersion = this.ownerSpeechVersion;
    const event = { text: turn.finalText, ms: { stt: turn.sttMs, utterance: turn.utteranceMs },
      ...turn.facts };
    void (async () => {
      // Only a real outage is "Luna is out"; any other failure just asks again.
      let line = OUTAGE_REASONS.has(reason) ? BRAIN_OUT_LINE : "Sorry, I lost that. Please say it again.";
      if (STATUS_KINDS.includes(turn.intent?.kind) && this.ownerRouter?.statusSentence) {
        try {
          line = await this.ownerRouter.statusSentence(turn.intent, { allowReference: turn.allowReference });
        } catch (error) {
          this.logger.warn?.("[conversation] status sentence:", error.message);
        }
      }
      if (!line || !this.started || speechVersion !== this.ownerSpeechVersion ||
        this.mode !== "conversation" || this.turn || this.reply) return;
      this.#speakControl(line, event);
    })();
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
    this.createDraft.reset();
    this.ownerRouter?.reset();
    this.ownerSpeechVersion += 1;
    this.ownerSpeaking = false;
    this.ownerAudioIncomplete = false;
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
        await chmod(this.logFile, 0o600);
      } catch (error) {
        this.logger.warn?.("[conversation] turn log:", error.message);
      }
    });
    return this.logQueue;
  }

  traceRoute(entry) { void this.#log({ type: "ebi_action", ...entry }); }

  logEvent(row) { void this.#log(row); }
}

export { heardWords, mergeText };
