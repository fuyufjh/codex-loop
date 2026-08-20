import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  queueThreadMessage,
  websocketTestUtils,
} from "../src/app-server-client.mjs";

test("queueThreadMessage initializes experimental API and adds a queued turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-timer-ws-"));
  const socketPath = path.join(directory, "app-server.sock");
  const requests = [];
  const server = net.createServer((socket) => serveFakeAppServer(socket, requests));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const response = await queueThreadMessage({
      threadId: "thread-123",
      message: "timer fired",
      clientUserMessageId: "client-message-123",
      socketPath,
    });
    assert.equal(response.queuedSubmission.id, "queued-123");
    assert.equal(requests[0].method, "initialize");
    assert.equal(requests[0].params.capabilities.experimentalApi, true);
    assert.equal(requests[1].method, "initialized");
    assert.deepEqual(requests[2], {
      method: "thread/queue/add",
      id: 2,
      params: {
        threadId: "thread-123",
        input: [{ type: "text", text: "timer fired" }],
        clientUserMessageId: "client-message-123",
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function serveFakeAppServer(socket, requests) {
  let handshake = Buffer.alloc(0);
  let websocketBuffer = Buffer.alloc(0);
  let upgraded = false;

  socket.on("data", (chunk) => {
    if (!upgraded) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const headers = handshake.subarray(0, end).toString("utf8");
      const key = headers.match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upgraded = true;
      websocketBuffer = handshake.subarray(end + 4);
      handshake = Buffer.alloc(0);
    } else {
      websocketBuffer = Buffer.concat([websocketBuffer, chunk]);
    }

    while (upgraded) {
      const frame = websocketTestUtils.decodeFrame(websocketBuffer);
      if (!frame) {
        return;
      }
      websocketBuffer = websocketBuffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 0x1) {
        continue;
      }
      const request = JSON.parse(frame.payload.toString("utf8"));
      requests.push(request);
      if (request.method === "initialize") {
        socket.write(
          encodeServerText({
            id: request.id,
            result: { userAgent: "codex_app_server/0.148.0" },
          }),
        );
      } else if (request.method === "thread/queue/add") {
        socket.write(
          encodeServerText({
            id: request.id,
            result: {
              queuedSubmission: {
                id: "queued-123",
                input: request.params.input,
                clientUserMessageId: request.params.clientUserMessageId,
              },
            },
          }),
        );
      }
    }
  });
}

function encodeServerText(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length <= 125) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
