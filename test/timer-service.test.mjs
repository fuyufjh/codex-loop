import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultTimerStateFile, TimerService } from "../src/timer-service.mjs";

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

test("timers survive service restarts and cancellation is persisted", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timer-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, "timers.json");
  const handles = [];
  const timeoutOptions = {
    setTimeoutImpl(callback, delayMs) {
      const handle = { callback, delayMs, unref() {} };
      handles.push(handle);
      return handle;
    },
    clearTimeoutImpl() {},
  };

  const first = new TimerService({
    deliver: async () => {},
    stateFile,
    now: () => 1_000,
    ...timeoutOptions,
  });
  const scheduled = first.scheduleOnce({
    threadId: "thread-a",
    delaySeconds: 60,
    message: "survive restart",
  });
  first.close();

  handles.length = 0;
  const second = new TimerService({
    deliver: async () => {},
    stateFile,
    now: () => 2_000,
    ...timeoutOptions,
  });
  assert.deepEqual(second.list("thread-a"), [scheduled]);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].delayMs, 59_000);
  assert.equal(second.cancel("thread-a", scheduled.id), true);
  second.close();

  const third = new TimerService({
    deliver: async () => {},
    stateFile,
    now: () => 2_000,
    ...timeoutOptions,
  });
  assert.deepEqual(third.list("thread-a"), []);
  third.close();
});

test("an overdue one-shot timer fires after restoration and is removed", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timer-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, "timers.json");
  const firstHandles = [];
  const first = new TimerService({
    minDelaySeconds: 0.001,
    deliver: async () => {},
    stateFile,
    now: () => 1_000,
    setTimeoutImpl(callback, delayMs) {
      const handle = { callback, delayMs, unref() {} };
      firstHandles.push(handle);
      return handle;
    },
    clearTimeoutImpl() {},
  });
  first.scheduleOnce({
    threadId: "thread-a",
    delaySeconds: 0.001,
    message: "overdue",
  });
  first.close();

  const delivered = [];
  const restoredHandles = [];
  const second = new TimerService({
    minDelaySeconds: 0.001,
    deliver: async (message) => delivered.push(message),
    stateFile,
    now: () => 2_000,
    setTimeoutImpl(callback, delayMs) {
      const handle = { callback, delayMs, unref() {} };
      restoredHandles.push(handle);
      return handle;
    },
    clearTimeoutImpl() {},
  });
  assert.equal(restoredHandles.length, 1);
  assert.equal(restoredHandles[0].delayMs, 0);
  restoredHandles[0].callback();
  await waitUntil(() => delivered.length === 1);
  assert.deepEqual(second.list("thread-a"), []);
  second.close();

  const third = new TimerService({
    minDelaySeconds: 0.001,
    deliver: async () => {},
    stateFile,
    now: () => 2_000,
    setTimeoutImpl() {
      throw new Error("removed timer must not be re-armed");
    },
  });
  assert.deepEqual(third.list("thread-a"), []);
  third.close();
});

test("an overdue interval fires once and persists its next interval", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timer-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, "timers.json");
  let now = 1_000;
  let handles = [];
  const options = () => ({
    minDelaySeconds: 0.001,
    stateFile,
    now: () => now,
    setTimeoutImpl(callback, delayMs) {
      const handle = { callback, delayMs, unref() {} };
      handles.push(handle);
      return handle;
    },
    clearTimeoutImpl() {},
  });

  const first = new TimerService({ deliver: async () => {}, ...options() });
  const scheduled = first.scheduleInterval({
    threadId: "thread-a",
    intervalSeconds: 0.01,
    message: "repeat",
  });
  first.close();

  now = 2_000;
  handles = [];
  const delivered = [];
  const second = new TimerService({
    deliver: async (message) => delivered.push(message),
    ...options(),
  });
  assert.equal(handles.length, 1);
  assert.equal(handles[0].delayMs, 0);
  handles[0].callback();
  await waitUntil(() => second.list("thread-a")[0]?.fireCount === 1);
  assert.equal(delivered.length, 1);
  assert.equal(second.list("thread-a")[0].id, scheduled.id);
  assert.equal(second.list("thread-a")[0].nextFireAt, new Date(2_010).toISOString());
  assert.equal(handles.at(-1).delayMs, 10);
  second.close();

  now = 2_005;
  handles = [];
  const third = new TimerService({ deliver: async () => {}, ...options() });
  assert.equal(third.list("thread-a")[0].fireCount, 1);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].delayMs, 5);
  third.close();
});

test("invalid persisted state fails closed instead of being overwritten", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timer-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, "timers.json");
  fs.writeFileSync(stateFile, "not json\n");

  assert.throws(
    () => new TimerService({ deliver: async () => {}, stateFile }),
    /invalid timer state/,
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), "not json\n");
});

test("default state path honors Codex environment overrides", () => {
  assert.equal(
    defaultTimerStateFile({ env: { CODEX_TIMER_STATE_FILE: "/tmp/custom.json" } }),
    "/tmp/custom.json",
  );
  assert.equal(
    defaultTimerStateFile({ env: { CODEX_HOME: "/tmp/codex-home" } }),
    "/tmp/codex-home/codex-timer/timers.json",
  );
  assert.equal(
    defaultTimerStateFile({ env: {}, homeDir: "/tmp/home" }),
    "/tmp/home/.codex/codex-timer/timers.json",
  );
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
