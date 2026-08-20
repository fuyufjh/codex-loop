import { execFile } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export async function resolveAppServerSocket({
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  if (env.CODEX_APP_SERVER_SOCKET) {
    return env.CODEX_APP_SERVER_SOCKET;
  }

  const codexBin = env.CODEX_BIN || "codex";
  const { stdout } = await execFileImpl(
    codexBin,
    ["app-server", "daemon", "version"],
    {
      encoding: "utf8",
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  const status = JSON.parse(stdout);
  if (status.status !== "running" || typeof status.socketPath !== "string") {
    throw new Error("Codex app-server daemon is not running");
  }
  return status.socketPath;
}

export async function queueThreadMessage({
  threadId,
  message,
  clientUserMessageId = crypto.randomUUID(),
  socketPath,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError("threadId must be a non-empty string");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("message must be a non-empty string");
  }

  const resolvedSocketPath =
    socketPath || (await resolveAppServerSocket({ env }));
  const client = new UnixWebSocketJsonRpcClient({
    socketPath: resolvedSocketPath,
    requestTimeoutMs,
  });

  try {
    await client.connect();
    await client.request("initialize", {
      clientInfo: {
        name: "codex_timer_mcp",
        title: "Codex Timer MCP",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return await client.request("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: message }],
      clientUserMessageId,
    });
  } finally {
    client.close();
  }
}

class UnixWebSocketJsonRpcClient {
  constructor({ socketPath, requestTimeoutMs }) {
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const request = http.request({
        socketPath: this.socketPath,
        path: "/",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });

      const timer = setTimeout(() => {
        request.destroy(new Error("Timed out connecting to Codex app-server"));
      }, this.requestTimeoutMs);

      request.once("upgrade", (response, socket, head) => {
        clearTimeout(timer);
        const expectedAccept = crypto
          .createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        if (response.headers["sec-websocket-accept"] !== expectedAccept) {
          socket.destroy();
          reject(new Error("Invalid WebSocket upgrade response from app-server"));
          return;
        }

        this.socket = socket;
        socket.on("data", (chunk) => {
          try {
            this.#onData(chunk);
          } catch (error) {
            socket.destroy();
            this.#fail(error);
          }
        });
        socket.once("error", (error) => this.#fail(error));
        socket.once("close", () =>
          this.#fail(new Error("Codex app-server connection closed")),
        );
        if (head.length > 0) {
          this.#onData(head);
        }
        resolve();
      });
      request.once("response", (response) => {
        clearTimeout(timer);
        response.resume();
        reject(
          new Error(
            `App-server refused WebSocket upgrade with HTTP ${response.statusCode}`,
          ),
        );
      });
      request.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
  }

  request(method, params) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server method ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encodeClientFrame(Buffer.alloc(0), 0x8));
      this.socket.end();
    }
    this.#rejectPending(new Error("Codex app-server client closed"));
  }

  #send(message) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Codex app-server client is not connected");
    }
    this.socket.write(
      encodeClientFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1),
    );
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === 0x8) {
        this.socket?.end();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket?.write(encodeClientFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode === 0x1) {
        this.fragments = [frame.payload];
      } else if (frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
      } else {
        continue;
      }
      if (!frame.fin) {
        continue;
      }

      const text = Buffer.concat(this.fragments).toString("utf8");
      this.fragments = [];
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        this.#fail(new Error(`Invalid JSON from Codex app-server: ${error.message}`));
        return;
      }
      if (message.id === undefined) {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `App-server request failed: ${message.error.message || JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function encodeClientFrame(payload, opcode) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;

  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const fin = Boolean(buffer[0] & 0x80);
  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const length = buffer.readBigUInt64BE(2);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large");
    }
    payloadLength = Number(length);
    offset = 10;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLength) {
    return null;
  }

  let payload = buffer.subarray(offset, offset + payloadLength);
  if (mask) {
    const unmasked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      unmasked[index] = payload[index] ^ mask[index % 4];
    }
    payload = unmasked;
  }
  return { fin, opcode, payload, consumed: offset + payloadLength };
}

export const websocketTestUtils = { decodeFrame };
