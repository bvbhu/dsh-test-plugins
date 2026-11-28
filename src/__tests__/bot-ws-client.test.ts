import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MiniWebSocket } from "../bot-ws-client.js";

/**
 * 用 node:http 手写一个最小 RFC 6455 服务端，验证 MiniWebSocket 客户端：
 * 握手、文本帧（短/长/分片）、ping→pong、close。
 */

function encodeFrame(opcode: number, payload: Buffer, fin: boolean, mask = false): Buffer {
  const finBit = fin ? 0x80 : 0;
  const maskBit = mask ? 0x80 : 0;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([finBit | opcode, maskBit | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = finBit | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = finBit | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const m = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ m[i % 4];
  return Buffer.concat([header, m, masked]);
}

import type { Duplex } from "node:stream";

let socketServer: Duplex | null = null;

function startServer(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(426).end("websocket only");
    });
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n",
      );
      socketServer = socket;
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function readFrame(socket: Duplex): Promise<{ opcode: number; payload: Buffer; fin: boolean }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      let payload: Buffer;
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const raw = buf.subarray(off + 4, off + 4 + len);
        payload = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i++) payload[i] = raw[i] ^ mask[i % 4];
      } else {
        payload = buf.subarray(off, off + len);
      }
      socket.off("data", onData);
      resolve({ opcode, payload, fin });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

function onceEvent(ws: MiniWebSocket, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    ws.on(event, (...args: unknown[]) => resolve(args));
  });
}

describe("MiniWebSocket", () => {
  it("handshake + short text frame + ping/pong + close", async () => {
    const { server, port } = await startServer();
    const ws = new MiniWebSocket(`ws://127.0.0.1:${port}/probe`);
    await onceEvent(ws, "open");
    expect(ws.readyState).toBe(1);

    const sock = socketServer!;
    sock.write(encodeFrame(0x1, Buffer.from("hello", "utf8"), true));
    const m = await onceEvent(ws, "message");
    expect((m[0] as { data: string }).data).toBe("hello");

    ws.send("x");
    const frame1 = await readFrame(sock);
    expect(frame1.opcode).toBe(1); // 客户端发来的文本帧
    sock.write(encodeFrame(0x9, Buffer.from("knock"), true)); // 服务端 ping
    const frame2 = await readFrame(sock);
    expect(frame2.opcode).toBe(0xa); // 客户端回 pong
    expect(frame2.payload.toString()).toBe("knock");

    ws.close();
    const frame3 = await readFrame(sock);
    expect(frame3.opcode).toBe(0x8);
    sock.end();
    server.close();
  });

  it("reassembles fragmented text frames", async () => {
    const { server, port } = await startServer();
    const ws = new MiniWebSocket(`ws://127.0.0.1:${port}/frag`);
    const gotMessage = onceEvent(ws, "message");
    await onceEvent(ws, "open");

    const sock = socketServer!;
    const text = "fragmented-payload-".repeat(40); // 920 bytes → 126 长度路径
    const payload = Buffer.from(text, "utf8");
    sock.write(encodeFrame(0x1, payload.subarray(0, 100), false)); // FIN=0 续片
    sock.write(encodeFrame(0x0, payload.subarray(100), true)); // FIN=1 尾片
    const m = await gotMessage;
    expect((m[0] as { data: string }).data).toBe(text);
    ws.close();
    sock.end();
    server.close();
  });

  it("handles long payload (64-bit length path)", async () => {
    const { server, port } = await startServer();
    const ws = new MiniWebSocket(`ws://127.0.0.1:${port}/long`);
    const gotMessage = onceEvent(ws, "message");
    await onceEvent(ws, "open");

    const sock = socketServer!;
    const text = "y".repeat(70000); // > 65536 → 127 长度路径
    sock.write(encodeFrame(0x1, Buffer.from(text, "utf8"), true));
    const m = await gotMessage;
    expect((m[0] as { data: string }).data).toBe(text);
    ws.close();
    sock.end();
    server.close();
  });
});
