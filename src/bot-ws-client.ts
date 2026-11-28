import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

/**
 * 极简 OneBot WS 客户端（RFC 6455 客户端侧子集）：纯 node:net 实现，不引 ws 包。
 * 原因：引 CJS 依赖会让 esbuild 产物带上 __require shim，宿主按 ESM import
 * 加载行模块时 "Dynamic require of ... is not supported" 直接炸（重启后整行
 * 加载失败，SL 永远拉不起来）。覆盖：握手、文本帧收发（分片重组）、
 * ping→pong、close、断线 error。
 */
class MiniWebSocket {
  private sock: Socket | null = null;
  private state = 0; // 0 CONNECTING 1 OPEN 2 CLOSING 3 CLOSED
  private buf: Buffer = Buffer.alloc(0);
  private handshaking = true;
  private fragments: Buffer[] = [];
  private readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;

  constructor(url: string) {
    const m = /^ws:\/\/([^/:]+)(?::(\d+))?([^?]*)(?:\?(.*))?$/.exec(url.trim());
    if (!m) throw new Error(`MiniWebSocket: bad url ${url}`);
    this.host = m[1];
    this.port = m[2] ? Number(m[2]) : 80;
    // 查询串必须带上（SnowLuma OneBot 的 access_token 走 query，丢了握手会被拒）
    this.path = m[3] + (m[4] ? `?${m[4]}` : "");
    this.connect();
  }

  get readyState(): number {
    return this.state;
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }

  off(event: string, fn: (...args: unknown[]) => void): this {
    const arr = this.listeners[event];
    if (arr) this.listeners[event] = arr.filter((f) => f !== fn);
    return this;
  }

  send(data: string): void {
    this.writeFrame(0x1, Buffer.from(data, "utf8"));
  }

  close(): void {
    if (this.state === 2 || this.state === 3) return;
    this.state = 2;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
    } catch {}
    this.destroy();
  }

  private connect(): void {
    const sock = netConnect({ host: this.host, port: this.port });
    this.sock = sock;
    sock.on("error", (err: Error) => {
      this.state = 3;
      this.emit("error", err);
      this.destroy();
    });
    sock.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      if (this.handshaking) this.parseHandshake();
      else this.parseFrames();
    });
    sock.on("close", () => {
      this.state = 3;
      this.emit("close");
      this.destroy();
    });
    sock.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      sock.write(
        `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  }

  private parseHandshake(): void {
    const idx = this.buf.indexOf("\r\n\r\n");
    if (idx === -1) {
      if (this.buf.length > 16 * 1024) this.fail(new Error("handshake header too long"));
      return;
    }
    const head = this.buf.subarray(0, idx).toString();
    this.buf = this.buf.subarray(idx + 4);
    this.handshaking = false;
    if (!/^HTTP\/1\.1 101/.test(head)) {
      this.fail(new Error(`handshake rejected: ${head.split("\r\n")[0]}`));
      return;
    }
    this.state = 1;
    this.emit("open");
    this.parseFrames();
  }

  private parseFrames(): void {
    while (this.buf.length >= 2) {
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const lenByte = this.buf[1];
      let payloadLen = lenByte & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (this.buf.length < 4) return;
        payloadLen = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) return;
        payloadLen = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buf.length < offset + payloadLen) return;
      const payload = this.buf.subarray(offset, offset + payloadLen);
      this.buf = this.buf.subarray(offset + payloadLen);
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload); // ping → pong
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x8) {
      if (this.state !== 2) {
        this.writeFrame(0x8, payload);
        this.state = 3;
        this.emit("close");
      }
      this.destroy();
      return;
    }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.state = 1;
        this.emit("message", { data: text });
      }
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.sock || this.state === 3) return;
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  private fail(err: Error): void {
    this.state = 3;
    this.emit("error", err);
    this.destroy();
  }

  private destroy(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
}


export { MiniWebSocket };
