import crypto from "node:crypto";

const DEFAULT_MAX_DELAY_SECONDS = 24 * 60 * 60;

export class TimerService {
  constructor({
    deliver,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    minDelaySeconds = 1,
    maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
    onEvent = () => {},
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
    this.timers = new Map();
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
    this.clearTimeoutImpl(timer.handle);
    this.timers.delete(timerId);
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
    if (timer.intervalSeconds === null) {
      this.timers.delete(timerId);
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

    if (timer.intervalSeconds !== null && this.timers.has(timerId)) {
      timer.nextFireAtMs = this.now() + timer.intervalSeconds * 1000;
      this.#arm(timer, timer.intervalSeconds * 1000);
    }
  }
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
