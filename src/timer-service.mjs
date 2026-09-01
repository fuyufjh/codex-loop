import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_DELAY_SECONDS = 24 * 60 * 60;
const STATE_VERSION = 1;

export class TimerService {
  constructor({
    deliver,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    minDelaySeconds = 1,
    maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
    onEvent = () => {},
    stateFile = null,
  }) {
    if (typeof deliver !== "function") {
      throw new TypeError("deliver must be a function");
    }
    this.deliver = deliver;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.minDelaySeconds = minDelaySeconds;
    this.maxDelaySeconds = maxDelaySeconds;
    this.onEvent = onEvent;
    this.stateFile = stateFile;
    this.timers = new Map();
    this.#restore();
  }

  scheduleOnce({ threadId, delaySeconds, message }) {
    return this.#schedule({
      threadId,
      delaySeconds,
      intervalSeconds: null,
      message,
    });
  }

  scheduleInterval({ threadId, intervalSeconds, message }) {
    return this.#schedule({
      threadId,
      delaySeconds: intervalSeconds,
      intervalSeconds,
      message,
    });
  }

  list(threadId) {
    return [...this.timers.values()]
      .filter((timer) => timer.threadId === threadId)
      .sort((left, right) => left.nextFireAtMs - right.nextFireAtMs)
      .map(publicTimer);
  }

  cancel(threadId, timerId) {
    const timer = this.timers.get(timerId);
    if (!timer || timer.threadId !== threadId) {
      return false;
    }
    this.timers.delete(timerId);
    try {
      this.#persist();
    } catch (error) {
      this.timers.set(timerId, timer);
      throw error;
    }
    this.clearTimeoutImpl(timer.handle);
    return true;
  }

  close() {
    for (const timer of this.timers.values()) {
      this.clearTimeoutImpl(timer.handle);
    }
    this.timers.clear();
  }

  #schedule({ threadId, delaySeconds, intervalSeconds, message }) {
    validateThreadId(threadId);
    validateMessage(message);
    this.#validateDelay(delaySeconds);
    if (intervalSeconds !== null) {
      this.#validateDelay(intervalSeconds);
    }

    const id = crypto.randomUUID();
    const timer = {
      id,
      threadId,
      message,
      intervalSeconds,
      createdAtMs: this.now(),
      nextFireAtMs: this.now() + delaySeconds * 1000,
      fireCount: 0,
      lastError: null,
      handle: null,
    };
    this.timers.set(id, timer);
    try {
      this.#persist();
    } catch (error) {
      this.timers.delete(id);
      throw error;
    }
    this.#arm(timer, delaySeconds * 1000);
    return publicTimer(timer);
  }

  #validateDelay(value) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < this.minDelaySeconds ||
      value > this.maxDelaySeconds
    ) {
      throw new TypeError(
        `delay must be between ${this.minDelaySeconds} and ${this.maxDelaySeconds} seconds`,
      );
    }
  }

  #arm(timer, delayMs) {
    timer.handle = this.setTimeoutImpl(() => {
      void this.#fire(timer.id);
    }, delayMs);
    timer.handle?.unref?.();
  }

  async #fire(timerId) {
    const timer = this.timers.get(timerId);
    if (!timer) {
      return;
    }

    try {
      await this.deliver({
        threadId: timer.threadId,
        message: timer.message,
        timerId: timer.id,
        fireCount: timer.fireCount + 1,
      });
      timer.fireCount += 1;
      timer.lastError = null;
      this.onEvent({ type: "delivered", timer: publicTimer(timer) });
    } catch (error) {
      timer.lastError = error instanceof Error ? error.message : String(error);
      this.onEvent({
        type: "delivery_failed",
        timer: publicTimer(timer),
        error,
      });
    }

    if (this.timers.get(timerId) !== timer) {
      return;
    }

    if (timer.intervalSeconds === null) {
      this.timers.delete(timerId);
    } else {
      timer.nextFireAtMs = this.now() + timer.intervalSeconds * 1000;
    }

    try {
      this.#persist();
    } catch (error) {
      this.onEvent({
        type: "persistence_failed",
        timer: publicTimer(timer),
        error,
      });
    }

    if (timer.intervalSeconds !== null && this.timers.has(timerId)) {
      this.#arm(timer, Math.max(0, timer.nextFireAtMs - this.now()));
    }
  }

  #restore() {
    if (this.stateFile === null) {
      return;
    }

    let contents;
    try {
      contents = fs.readFileSync(this.stateFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw new Error(`failed to read timer state ${this.stateFile}: ${error.message}`, {
        cause: error,
      });
    }

    let state;
    try {
      state = JSON.parse(contents);
      validateState(state, this.minDelaySeconds, this.maxDelaySeconds);
    } catch (error) {
      throw new Error(`invalid timer state ${this.stateFile}: ${error.message}`, {
        cause: error,
      });
    }

    for (const stored of state.timers) {
      const timer = { ...stored, handle: null };
      this.timers.set(timer.id, timer);
    }
    for (const timer of this.timers.values()) {
      this.#arm(timer, Math.max(0, timer.nextFireAtMs - this.now()));
    }
  }

  #persist() {
    if (this.stateFile === null) {
      return;
    }

    const state = {
      version: STATE_VERSION,
      timers: [...this.timers.values()].map(storedTimer),
    };
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryFile, this.stateFile);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          this.onEvent({ type: "persistence_cleanup_failed", error: cleanupError });
        }
      }
      throw new Error(`failed to write timer state ${this.stateFile}: ${error.message}`, {
        cause: error,
      });
    }
  }
}

export function defaultTimerStateFile({ env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof env.CODEX_TIMER_STATE_FILE === "string" && env.CODEX_TIMER_STATE_FILE) {
    return path.resolve(env.CODEX_TIMER_STATE_FILE);
  }
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME
      ? env.CODEX_HOME
      : path.join(homeDir, ".codex");
  return path.join(codexHome, "codex-timer", "timers.json");
}

function validateThreadId(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError("threadId must be a non-empty string");
  }
}

function validateMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("message must be a non-empty string");
  }
  if (message.length > 10_000) {
    throw new TypeError("message cannot exceed 10000 characters");
  }
}

function validateState(state, minDelaySeconds, maxDelaySeconds) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }
  if (state.version !== STATE_VERSION) {
    throw new TypeError(`unsupported state version: ${state.version}`);
  }
  if (!Array.isArray(state.timers)) {
    throw new TypeError("state.timers must be an array");
  }

  const ids = new Set();
  for (const timer of state.timers) {
    if (!timer || typeof timer !== "object" || Array.isArray(timer)) {
      throw new TypeError("each stored timer must be an object");
    }
    if (typeof timer.id !== "string" || timer.id.length === 0) {
      throw new TypeError("stored timer id must be a non-empty string");
    }
    if (ids.has(timer.id)) {
      throw new TypeError(`duplicate stored timer id: ${timer.id}`);
    }
    ids.add(timer.id);
    validateThreadId(timer.threadId);
    validateMessage(timer.message);
    if (timer.intervalSeconds !== null) {
      validateStoredDelay(timer.intervalSeconds, minDelaySeconds, maxDelaySeconds);
    }
    validateTimestamp(timer.createdAtMs, "createdAtMs");
    validateTimestamp(timer.nextFireAtMs, "nextFireAtMs");
    if (!Number.isSafeInteger(timer.fireCount) || timer.fireCount < 0) {
      throw new TypeError("stored timer fireCount must be a non-negative integer");
    }
    if (timer.lastError !== null && typeof timer.lastError !== "string") {
      throw new TypeError("stored timer lastError must be a string or null");
    }
  }
}

function validateStoredDelay(value, minDelaySeconds, maxDelaySeconds) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minDelaySeconds ||
    value > maxDelaySeconds
  ) {
    throw new TypeError(
      `stored interval must be between ${minDelaySeconds} and ${maxDelaySeconds} seconds`,
    );
  }
}

function validateTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`stored timer ${name} must be a non-negative integer`);
  }
}

function storedTimer(timer) {
  return {
    id: timer.id,
    threadId: timer.threadId,
    message: timer.message,
    intervalSeconds: timer.intervalSeconds,
    createdAtMs: timer.createdAtMs,
    nextFireAtMs: timer.nextFireAtMs,
    fireCount: timer.fireCount,
    lastError: timer.lastError,
  };
}

function publicTimer(timer) {
  return {
    id: timer.id,
    kind: timer.intervalSeconds === null ? "once" : "interval",
    message: timer.message,
    intervalSeconds: timer.intervalSeconds,
    createdAt: new Date(timer.createdAtMs).toISOString(),
    nextFireAt: new Date(timer.nextFireAtMs).toISOString(),
    fireCount: timer.fireCount,
    lastError: timer.lastError,
  };
}
