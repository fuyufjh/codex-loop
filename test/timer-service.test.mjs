import assert from "node:assert/strict";
import test from "node:test";

import { TimerService } from "../src/timer-service.mjs";

test("one-shot timers deliver once and disappear", async () => {
  const delivered = [];
  const service = new TimerService({
    minDelaySeconds: 0.001,
    deliver: async (message) => delivered.push(message),
  });

  const timer = service.scheduleOnce({
    threadId: "thread-a",
    delaySeconds: 0.005,
    message: "wake up",
  });
  assert.equal(service.list("thread-a").length, 1);

  await waitUntil(() => delivered.length === 1);
  assert.equal(delivered[0].threadId, "thread-a");
  assert.equal(delivered[0].message, "wake up");
  assert.equal(delivered[0].timerId, timer.id);
  assert.deepEqual(service.list("thread-a"), []);
  service.close();
});

test("interval timers repeat until cancelled", async () => {
  const delivered = [];
  const service = new TimerService({
    minDelaySeconds: 0.001,
    deliver: async (message) => delivered.push(message),
  });

  const timer = service.scheduleInterval({
    threadId: "thread-a",
    intervalSeconds: 0.005,
    message: "check progress",
  });
  await waitUntil(() => delivered.length >= 2);
  assert.equal(service.cancel("thread-a", timer.id), true);
  const countAfterCancel = delivered.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered.length, countAfterCancel);
  assert.equal(service.cancel("thread-a", timer.id), false);
  service.close();
});

test("timers are isolated by thread", () => {
  const service = new TimerService({ deliver: async () => {} });
  const timer = service.scheduleOnce({
    threadId: "thread-a",
    delaySeconds: 60,
    message: "private",
  });

  assert.equal(service.list("thread-b").length, 0);
  assert.equal(service.cancel("thread-b", timer.id), false);
  assert.equal(service.list("thread-a").length, 1);
  service.close();
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
