import readline from "node:readline";

import { queueThreadMessage } from "./app-server-client.mjs";
import { defaultTimerStateFile, TimerService } from "./timer-service.mjs";

const SERVER_INFO = { name: "codex-timer", version: "0.2.0" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_MAX_DELAY_SECONDS = 24 * 60 * 60;

const TOOLS = [
  {
    name: "schedule_once",
    title: "Schedule one Codex message",
    description:
      "Persistently schedule one user message for the current Codex thread after a short delay.",
    inputSchema: {
      type: "object",
      properties: {
        delay_seconds: {
          type: "number",
          minimum: 1,
          maximum: DEFAULT_MAX_DELAY_SECONDS,
          description: "Delay before delivery, in seconds.",
        },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 10_000,
          description:
            "The future user message to queue into the current Codex thread.",
        },
      },
      required: ["delay_seconds", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "schedule_interval",
    title: "Schedule recurring Codex messages",
    description:
      "Persistently schedule a user message for the current Codex thread at a short fixed interval. The first delivery occurs after one interval.",
    inputSchema: {
      type: "object",
      properties: {
        interval_seconds: {
          type: "number",
          minimum: 1,
          maximum: DEFAULT_MAX_DELAY_SECONDS,
          description: "Interval between delivery attempts, in seconds.",
        },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 10_000,
          description:
            "The future user message to queue into the current Codex thread.",
        },
      },
      required: ["interval_seconds", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "list_timers",
    title: "List Codex timers",
    description: "List active persistent timers for the current Codex thread.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "cancel_timer",
    title: "Cancel a Codex timer",
    description:
      "Cancel an active persistent timer owned by the current Codex thread. A message already handed to the Codex queue is not retracted.",
    inputSchema: {
      type: "object",
      properties: {
        timer_id: {
          type: "string",
          minLength: 1,
          description: "Timer ID returned by schedule_once or schedule_interval.",
        },
      },
      required: ["timer_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

export function startMcpServer({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  timerService,
} = {}) {
  const service =
    timerService ||
    new TimerService({
      deliver: ({ threadId, message }) =>
        queueThreadMessage({ threadId, message }),
      onEvent: (event) => {
        if (event.type === "delivery_failed") {
          errorOutput.write(
            `[codex-timer] delivery failed for ${event.timer.id}: ${event.timer.lastError}\n`,
          );
        } else if (event.type.startsWith("persistence_")) {
          const timer = event.timer ? ` for ${event.timer.id}` : "";
          errorOutput.write(
            `[codex-timer] ${event.type}${timer}: ${event.error?.message || event.error}\n`,
          );
        }
      },
      stateFile: defaultTimerStateFile(),
    });

  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  lines.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }
    void handleLine(line, service, output);
  });
  lines.once("close", () => service.close());

  const shutdown = () => {
    service.close();
    lines.close();
  };
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  return { close: shutdown, timerService: service };
}

async function handleLine(line, timerService, output) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeMessage(output, rpcError(null, -32700, "Parse error"));
    return;
  }

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    writeMessage(output, rpcError(request?.id ?? null, -32600, "Invalid Request"));
    return;
  }
  if (request.id === undefined) {
    return;
  }

  try {
    switch (request.method) {
      case "initialize": {
        const protocolVersion =
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;
        writeMessage(output, {
          id: request.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "Use schedule_once for one future message and schedule_interval for short recurring messages. Timers are persisted and restored when this MCP server restarts.",
          },
        });
        return;
      }
      case "ping":
        writeMessage(output, { id: request.id, result: {} });
        return;
      case "tools/list":
        writeMessage(output, { id: request.id, result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const result = await callTool(request.params, timerService);
        writeMessage(output, { id: request.id, result });
        return;
      }
      default:
        writeMessage(
          output,
          rpcError(request.id, -32601, `Method not found: ${request.method}`),
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMessage(output, { id: request.id, result: toolError(message) });
  }
}

async function callTool(params, timerService) {
  if (!params || typeof params.name !== "string") {
    throw new TypeError("tools/call requires a tool name");
  }
  const args = params.arguments || {};
  const threadId = params._meta?.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error(
      "Codex did not provide _meta.threadId; this server requires Codex CLI 0.148.0 or newer",
    );
  }

  switch (params.name) {
    case "schedule_once": {
      assertOnlyKeys(args, ["delay_seconds", "message"]);
      const timer = timerService.scheduleOnce({
        threadId,
        delaySeconds: args.delay_seconds,
        message: args.message,
      });
      return toolSuccess(
        timer,
        `Scheduled one message for ${timer.nextFireAt} (timer ${timer.id}).`,
      );
    }
    case "schedule_interval": {
      assertOnlyKeys(args, ["interval_seconds", "message"]);
      const timer = timerService.scheduleInterval({
        threadId,
        intervalSeconds: args.interval_seconds,
        message: args.message,
      });
      return toolSuccess(
        timer,
        `Scheduled a recurring message every ${timer.intervalSeconds} seconds (timer ${timer.id}).`,
      );
    }
    case "list_timers": {
      assertOnlyKeys(args, []);
      const timers = timerService.list(threadId);
      return toolSuccess(
        { timers },
        timers.length === 0
          ? "No active timers for this Codex thread."
          : JSON.stringify(timers, null, 2),
      );
    }
    case "cancel_timer": {
      assertOnlyKeys(args, ["timer_id"]);
      if (typeof args.timer_id !== "string" || args.timer_id.length === 0) {
        throw new TypeError("timer_id must be a non-empty string");
      }
      const cancelled = timerService.cancel(threadId, args.timer_id);
      return toolSuccess(
        { timerId: args.timer_id, cancelled },
        cancelled
          ? `Cancelled timer ${args.timer_id}.`
          : `Timer ${args.timer_id} was not found for this Codex thread.`,
      );
    }
    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
}

function assertOnlyKeys(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`unexpected argument(s): ${unexpected.join(", ")}`);
  }
}

function toolSuccess(structuredContent, text) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function rpcError(id, code, message) {
  return { id, error: { code, message } };
}

function writeMessage(output, message) {
  output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

export const mcpTools = TOOLS;
