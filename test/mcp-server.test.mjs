import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

test("MCP protocol lists tools and scopes timer operations to _meta.threadId", async (t) => {
  const stateFile = temporaryStateFile(t);
  const child = spawnServer(stateFile);
  const responses = responseReader(child.stdout);

  try {
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    const initialized = await responses.next(1);
    assert.equal(initialized.jsonrpc, "2.0");
    assert.equal(initialized.result.protocolVersion, "2025-06-18");

    child.stdin.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ id: 2, method: "tools/list", params: {} })}\n`);
    const listed = await responses.next(2);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["schedule_once", "schedule_interval", "list_timers", "cancel_timer"],
    );

    child.stdin.write(
      `${JSON.stringify({
        id: 3,
        method: "tools/call",
        params: {
          name: "schedule_once",
          arguments: { delay_seconds: 60, message: "later" },
          _meta: { threadId: "thread-a" },
        },
      })}\n`,
    );
    const scheduled = await responses.next(3);
    assert.equal(scheduled.result.isError, false);
    const timerId = scheduled.result.structuredContent.id;

    child.stdin.write(
      `${JSON.stringify({
        id: 4,
        method: "tools/call",
        params: {
          name: "list_timers",
          arguments: {},
          _meta: { threadId: "thread-b" },
        },
      })}\n`,
    );
    assert.deepEqual((await responses.next(4)).result.structuredContent.timers, []);

    child.stdin.write(
      `${JSON.stringify({
        id: 5,
        method: "tools/call",
        params: {
          name: "cancel_timer",
          arguments: { timer_id: timerId },
          _meta: { threadId: "thread-a" },
        },
      })}\n`,
    );
    assert.equal((await responses.next(5)).result.structuredContent.cancelled, true);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("scheduling fails clearly without Codex thread metadata", async (t) => {
  const child = spawnServer(temporaryStateFile(t));
  const responses = responseReader(child.stdout);

  try {
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "tools/call",
        params: {
          name: "schedule_once",
          arguments: { delay_seconds: 60, message: "later" },
        },
      })}\n`,
    );
    const response = await responses.next(1);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /_meta\.threadId/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("the MCP server restores timers after a process restart", async (t) => {
  const stateFile = temporaryStateFile(t);
  const first = spawnServer(stateFile);
  const firstResponses = responseReader(first.stdout);
  let timerId;

  try {
    first.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "tools/call",
        params: {
          name: "schedule_once",
          arguments: { delay_seconds: 60, message: "persist me" },
          _meta: { threadId: "thread-persistent" },
        },
      })}\n`,
    );
    const scheduled = await firstResponses.next(1);
    assert.equal(scheduled.result.isError, false);
    timerId = scheduled.result.structuredContent.id;
  } finally {
    first.stdin.end();
    await new Promise((resolve) => first.once("exit", resolve));
  }

  const second = spawnServer(stateFile);
  const secondResponses = responseReader(second.stdout);
  try {
    second.stdin.write(
      `${JSON.stringify({
        id: 2,
        method: "tools/call",
        params: {
          name: "list_timers",
          arguments: {},
          _meta: { threadId: "thread-persistent" },
        },
      })}\n`,
    );
    const listed = await secondResponses.next(2);
    assert.deepEqual(
      listed.result.structuredContent.timers.map((timer) => timer.id),
      [timerId],
    );
  } finally {
    second.stdin.end();
    await new Promise((resolve) => second.once("exit", resolve));
  }
});

function spawnServer(stateFile) {
  return spawn(process.execPath, ["bin/codex-timer-mcp.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CODEX_TIMER_STATE_FILE: stateFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function temporaryStateFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timer-mcp-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "timers.json");
}

function responseReader(stream) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const queued = [];
  const waiters = [];
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    const waiterIndex = waiters.findIndex((waiter) => waiter.id === value.id);
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(value);
    } else {
      queued.push(value);
    }
  });
  return {
    next(id) {
      const queuedIndex = queued.findIndex((value) => value.id === id);
      if (queuedIndex >= 0) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`response ${id} timed out`)), 2_000);
        waiters.push({
          id,
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}
