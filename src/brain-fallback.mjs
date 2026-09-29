import { EventEmitter } from "node:events";

/**
 * Failure reasons that mean "this provider cannot answer right now", so switch brains:
 * the usage-limit family and the unreachable family (Codex's own error-info variants
 * for a lost or failing connection to its service included).
 */
export const SWITCH_REASONS = Object.freeze(new Set([
  "usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded",
  "unreachable", "timeout", "httpConnectionFailed", "responseStreamConnectionFailed",
  "responseStreamDisconnected", "responseTooManyFailedAttempts", "internalServerError",
]));

const FORWARDED_EVENTS = ["firstWord", "thinking", "notification"];

function tagged(error, brain) {
  if (error && typeof error === "object" && error.brain === undefined) error.brain = brain;
  return error;
}

/**
 * Two brains behind the `Brain` interface: the primary answers until it fails with a
 * switchable reason before its first word, then the secondary answers the same ask()
 * (the caller sees one stream). The primary is tried again after `retryAfterMs`; a
 * failed retry pushes the next one out by the same interval. Emits "brainSwitched"
 * {from, to, reason} on every change; interrupt(), injectContext() and close() reach
 * both brains, and a failing secondary rejects with its reason so the conversation can
 * say the honest line. "fatal" is re-emitted only from the brain answering the current
 * ask(), and never for a primary failure the chain recovers from by switching.
 */
export class FallbackBrain extends EventEmitter {
  constructor({ primary, secondary, retryAfterMs = 600_000, clock = Date.now, logger = console } = {}) {
    super();
    if (!primary || !secondary) throw new Error("primary and secondary brains are required");
    this.primary = primary;
    this.secondary = secondary;
    this.names = { primary: primary.name || "primary", secondary: secondary.name || "secondary" };
    this.retryAfterMs = retryAfterMs;
    this.clock = clock;
    this.logger = logger;
    this.outage = null; // { reason, since } while the primary is marked out
    this.answering = null; // the brain streaming the current ask()
    for (const brain of [primary, secondary]) {
      for (const event of FORWARDED_EVENTS) brain.on?.(event, (payload) => this.emit(event, payload));
      brain.on?.("fatal", (error) => this.#fatal(brain, error));
    }
  }

  /** Name of the brain the next ask() will try first. */
  get active() {
    return this.#primaryDue() ? this.names.primary : this.names.secondary;
  }

  async prewarm() {
    if (this.#primaryDue()) {
      try {
        return await this.primary.prewarm();
      } catch (error) {
        if (!SWITCH_REASONS.has(error?.reason)) throw tagged(error, this.names.primary);
        this.#markOut(error);
      }
    }
    return this.secondary.prewarm();
  }

  async *ask(text, options = {}) {
    if (this.#primaryDue()) {
      let spoken = false;
      this.answering = this.primary;
      try {
        for await (const sentence of this.primary.ask(text, options)) {
          spoken = true;
          this.#recovered();
          yield sentence;
        }
        this.#recovered();
        return;
      } catch (error) {
        tagged(error, this.names.primary);
        if (!SWITCH_REASONS.has(error?.reason)) throw error;
        this.#markOut(error);
        if (spoken) throw error; // a half-spoken reply is never re-asked
      } finally {
        if (this.answering === this.primary) this.answering = null;
      }
    }
    this.answering = this.secondary;
    try {
      yield* this.secondary.ask(text, options);
    } catch (error) {
      throw tagged(error, this.names.secondary);
    } finally {
      if (this.answering === this.secondary) this.answering = null;
    }
  }

  async interrupt() {
    const results = await Promise.all([this.primary.interrupt(), this.secondary.interrupt()]);
    return results.some(Boolean);
  }

  injectContext(text) {
    this.primary.injectContext?.(text);
    this.secondary.injectContext?.(text);
  }

  async close() {
    await Promise.all([this.primary.close(), this.secondary.close()]);
  }

  /** An idle brain failing, or a primary failure the chain recovers from, fails no turn. */
  #fatal(brain, error) {
    if (brain !== this.answering) return;
    if (brain === this.primary && SWITCH_REASONS.has(error?.reason)) return;
    this.emit("fatal", tagged(error, brain === this.primary ? this.names.primary : this.names.secondary));
  }

  #primaryDue() {
    return !this.outage || this.clock() - this.outage.since >= this.retryAfterMs;
  }

  #markOut(error) {
    const reason = error?.reason;
    this.outage = { reason, since: this.clock() };
    this.logger.warn?.(`[brain] ${this.names.primary} out (${reason}); using ${this.names.secondary}:`,
      error?.message);
    this.emit("brainSwitched", { from: this.names.primary, to: this.names.secondary, reason });
  }

  #recovered() {
    if (!this.outage) return;
    this.outage = null;
    this.logger.info?.(`[brain] ${this.names.primary} is back`);
    this.emit("brainSwitched", { from: this.names.secondary, to: this.names.primary, reason: "recovered" });
  }
}
