#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(projectRoot, "bin", "codex-timer-mcp.mjs");
const codexBin = process.env.CODEX_BIN || "codex";
const timeoutMs = 60_000;
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-timer-compat-"),
);
const stateFile = path.join(temporaryDirectory, "timers.json");

const child = spawn(
  codexBin,
  [
    "app-server",
    "-c",
    'mcp_servers.codex_timer.command="node"',
    "-c",
    `mcp_servers.codex_timer.args=[${JSON.stringify(serverPath)}]`,
    "-c",
    "mcp_servers.codex_timer.tool_timeout_sec=10",
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, CODEX_TIMER_STATE_FILE: stateFile },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
let ephemeralThreadId;
let timerId;
let scheduledResult;
let listedResult;

try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Codex compatibility test timed out\n${stderr.join("")}`),
      );
    }, timeoutMs);

    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        if (message.error) {
          reject(new Error(`initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 2,
          params: { cwd: projectRoot, ephemeral: true },
        });
      } else if (message.id === 2) {
        if (message.error) {
          reject(new Error(`thread/start failed: ${JSON.stringify(message.error)}`));
          return;
        }
        ephemeralThreadId = message.result.thread.id;
        send({
          method: "mcpServer/tool/call",
          id: 3,
          params: {
            threadId: ephemeralThreadId,
            server: "codex_timer",
            tool: "schedule_once",
            arguments: {
              delay_seconds: 60,
              message: "compatibility test message that will be cancelled",
            },
          },
        });
      } else if (message.id === 3) {
        if (message.error) {
          reject(
            new Error(
              `mcpServer/tool/call failed: ${JSON.stringify(message.error)}`,
            ),
          );
          return;
        }
        scheduledResult = message.result;
        timerId = scheduledResult.structuredContent?.id;
        send({
          method: "mcpServer/tool/call",
          id: 4,
          params: {
            threadId: ephemeralThreadId,
            server: "codex_timer",
            tool: "list_timers",
            arguments: {},
          },
        });
      } else if (message.id === 4) {
        if (message.error) {
          reject(
            new Error(
              `list_timers failed: ${JSON.stringify(message.error)}`,
            ),
          );
          return;
        }
        listedResult = message.result;
        send({
          method: "mcpServer/tool/call",
          id: 5,
          params: {
            threadId: ephemeralThreadId,
            server: "codex_timer",
            tool: "cancel_timer",
            arguments: { timer_id: timerId },
          },
        });
      } else if (message.id === 5) {
        clearTimeout(timer);
        if (message.error) {
          reject(
            new Error(
              `cancel_timer failed: ${JSON.stringify(message.error)}`,
            ),
          );
          return;
        }
        resolve({
          scheduled: scheduledResult,
          listed: listedResult,
          cancelled: message.result,
        });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Temporary app-server exited with code ${code}\n${stderr.join("")}`,
        ),
      );
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "codex-timer-compat-test",
          title: "Codex Timer Compatibility Test",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });

  if (
    result.scheduled.isError ||
    result.listed.isError ||
    result.cancelled.isError ||
    result.listed.structuredContent?.timers?.length !== 1 ||
    result.cancelled.structuredContent?.cancelled !== true
  ) {
    throw new Error(`Codex MCP calls returned an invalid result: ${JSON.stringify(result)}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        compatible: true,
        scheduledTimerId: result.scheduled.structuredContent.id,
        listedTimerCount: result.listed.structuredContent.timers.length,
        cancelled: result.cancelled.structuredContent.cancelled,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  lines.close();
  child.kill("SIGTERM");
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
