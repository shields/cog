// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createHash, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import net from "node:net";
import { readKeyFile } from "./key-file.ts";

// A Lima guest reaches the Mac's 127.0.0.1 through its host address, and
// nothing there forwards to ::1, so the listener must never move to 127.0.0.1
// or to a name that resolves to it.
export const proxyAddress = "::1";
export const proxyPort = 17_443;
export const proxyUser = "cog";
export const interceptedHost = "api.anthropic.com";

const headLimit = 8192;
const headTimeout = 5000;
const connectTimeout = 30_000;
const idleTimeout = 1_200_000;
const connectionLimit = 1024;
const waitingLimit = 64;
const keepAliveDelay = 60_000;

const keyPattern = /^[A-Za-z0-9_-]{43}$/u;

export function proxyUrl(key: string, port = proxyPort): string {
  return `http://${proxyUser}:${key}@[${proxyAddress}]:${String(port)}`;
}

// A reason never holds the file's content or any part of it.
export type ProxyUrlResult =
  | { kind: "key"; key: string }
  | { kind: "missing" }
  | { kind: "unusable"; reason: string };

export function readProxyUrl(file: string, port = proxyPort): ProxyUrlResult {
  const result = readKeyFile(file);
  if (result.kind !== "key") {
    return result;
  }
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      return { kind: "unusable", reason: "is open to other users" };
    }
  } catch {
    return { kind: "unusable", reason: "cannot be read" };
  }
  const prefix = `http://${proxyUser}:`;
  const suffix = `@[${proxyAddress}]:${String(port)}`;
  const key = result.key.slice(prefix.length, -suffix.length);
  if (
    !result.key.startsWith(prefix) ||
    !result.key.endsWith(suffix) ||
    !keyPattern.test(key)
  ) {
    return {
      kind: "unusable",
      reason: "does not hold a proxy URL that this cog wrote",
    };
  }
  return { kind: "key", key };
}

export interface ProxyStatus {
  state: "off" | "unusable" | "listening";
  reason: string | null;
}

export interface ProxyRequest {
  method: string;
  target: string;
  authorization: string[];
  rest: Buffer;
}

const requestLine = /^([A-Z]+) ([!-~]+) HTTP\/1\.[01]$/u;
const headerLine = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([\t\u{20}-\u{7E}]*)$/u;

// null while the head has not ended, and "malformed" for one that is too long
// or is not a request this proxy reads.
export function parseHead(buffer: Buffer): ProxyRequest | "malformed" | null {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) {
    return buffer.length > headLimit ? "malformed" : null;
  }
  if (end > headLimit) {
    return "malformed";
  }
  const [first = "", ...lines] = buffer
    .subarray(0, end)
    .toString("latin1")
    .split("\r\n");
  const request = requestLine.exec(first);
  if (request === null) {
    return "malformed";
  }
  const authorization: string[] = [];
  for (const line of lines) {
    const header = headerLine.exec(line);
    if (header === null) {
      return "malformed";
    }
    if (header[1]?.toLowerCase() === "proxy-authorization") {
      authorization.push((header[2] ?? "").trim());
    }
  }
  return {
    method: request[1] ?? "",
    target: request[2] ?? "",
    authorization,
    rest: buffer.subarray(end + 4),
  };
}

const basic = /^basic +([A-Za-z0-9+/]+={0,2})$/iu;

function digest(value: Buffer | string): Buffer {
  return createHash("sha256").update(value).digest();
}

// The digests are compared, so the comparison takes the same time whatever
// the offered value is and however long it is.
export function authorized(
  authorization: readonly string[],
  key: string,
): boolean {
  const [value, ...others] = authorization;
  if (value === undefined || others.length > 0) {
    return false;
  }
  const offered = basic.exec(value)?.[1];
  return (
    offered !== undefined &&
    timingSafeEqual(
      digest(Buffer.from(offered, "base64")),
      digest(`${proxyUser}:${key}`),
    )
  );
}

const namedTarget = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,252}):([0-9]{1,5})$/u;
const bracketedTarget = /^\[([0-9A-Fa-f:.]{2,45})\]:([0-9]{1,5})$/u;

export function parseTarget(
  target: string,
): { host: string; port: number } | null {
  const match = namedTarget.exec(target) ?? bracketedTarget.exec(target);
  const host = match?.[1];
  return match === null || host === undefined
    ? null
    : { host, port: Number(match[2]) };
}

export function isIntercepted(host: string): boolean {
  return host.toLowerCase().replace(/\.$/u, "") === interceptedHost;
}

export type Decision =
  | { kind: "refuse"; status: 400 | 403 | 405 | 407; message: string }
  | { kind: "tunnel"; host: string; intercepted: boolean };

// The credential is judged first, so that a caller without it learns nothing
// about what the proxy would do with a request.
export function decide(request: ProxyRequest, key: string): Decision {
  if (!authorized(request.authorization, key)) {
    return {
      kind: "refuse",
      status: 407,
      message: "the cog proxy needs its key",
    };
  }
  if (request.method !== "CONNECT") {
    return {
      kind: "refuse",
      status: 405,
      message: "the cog proxy only tunnels HTTPS",
    };
  }
  const target = parseTarget(request.target);
  if (target === null) {
    return { kind: "refuse", status: 400, message: "invalid CONNECT target" };
  }
  if (target.port !== 443) {
    return {
      kind: "refuse",
      status: 403,
      message: "the cog proxy only tunnels to port 443",
    };
  }
  return {
    kind: "tunnel",
    host: target.host,
    intercepted: isIntercepted(target.host),
  };
}

const statusText = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  407: "Proxy Authentication Required",
  502: "Bad Gateway",
  504: "Gateway Timeout",
} as const;

export function refusal(
  status: keyof typeof statusText,
  message: string,
): string {
  const body = `${message}\n`;
  return [
    `HTTP/1.1 ${String(status)} ${statusText[status]}`,
    ...(status === 407 ? ['Proxy-Authenticate: Basic realm="cog"'] : []),
    "Content-Type: text/plain",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

const established = "HTTP/1.1 200 Connection Established\r\n\r\n";

export interface ProxyOptions {
  key: string;
  // The Unix socket of the instance that serves the intercepted host.
  socket: string;
  port?: number;
  // Called once if the listener fails after it began to listen.
  onFailure?: () => void;
  connect?: (host: string) => net.Socket;
  headTimeout?: number;
  connectTimeout?: number;
  idleTimeout?: number;
  connectionLimit?: number;
  waitingLimit?: number;
}

interface Connection {
  client: net.Socket;
  onward: net.Socket | null;
  intercepted: boolean;
  waiting: boolean;
  // The sockets that have not closed yet. The connection stays listed until
  // both have, so that an end that waits for a peer that has stopped reading
  // is still found by the idle timer and by close().
  open: number;
  idle: NodeJS.Timeout | null;
}

function toInternet(host: string): net.Socket {
  return net.connect({ host, port: 443, allowHalfOpen: true });
}

// What the end that closed sent has been handed to the other end, and
// destroying that end at once would drop whatever it has not written yet.
function finish(other: net.Socket): void {
  if (!other.writableEnded || other.writableFinished) {
    other.destroy();
  } else {
    other.once("finish", () => {
      other.destroy();
    });
  }
}

export class ConnectProxy {
  readonly key: string;
  readonly socket: string;
  readonly #options: ProxyOptions;
  readonly #server: net.Server;
  readonly #connections = new Set<Connection>();
  #waiting = 0;
  #emptied: (() => void) | null = null;
  #closed: Promise<void> = Promise.resolve();
  #listening = false;
  #quiesced = false;

  constructor(options: ProxyOptions) {
    this.key = options.key;
    this.socket = options.socket;
    this.#options = options;
    this.#server = net.createServer({ allowHalfOpen: true }, (client) => {
      this.#accept(client);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(
        {
          host: proxyAddress,
          port: this.#options.port ?? proxyPort,
          ipv6Only: true,
        },
        () => {
          this.#server.off("error", reject);
          if (this.#quiesced) {
            this.#closed = new Promise<void>((done) => {
              this.#server.close(() => {
                done();
                reject(new Error("the proxy was closed before it listened"));
              });
            });
            return;
          }
          this.#listening = true;
          // The daemon serves every VM, so a fault of this listener ends the
          // proxy and nothing else.
          this.#server.once("error", () => {
            void this.close();
            this.#options.onFailure?.();
          });
          resolve();
        },
      );
    });
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the proxy is not listening");
    }
    return address.port;
  }

  // An intercepted tunnel is spared: it carries a request that the instance's
  // server finishes, and ends when that server closes its side.
  quiesce(): void {
    if (this.#quiesced) {
      return;
    }
    this.#quiesced = true;
    if (this.#listening) {
      this.#closed = new Promise<void>((resolve) => {
        this.#server.close(() => {
          resolve();
        });
      });
    }
    for (const connection of this.#connections) {
      if (!connection.intercepted) {
        this.#drop(connection);
      }
    }
  }

  // The grace is for a tunnel whose instance has just answered and closed: it
  // still holds the end of that answer.
  async close(grace = 0): Promise<void> {
    this.quiesce();
    if (grace > 0 && this.#connections.size > 0) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      const expired = setTimeout(resolve, grace);
      this.#emptied = resolve;
      await promise;
      this.#emptied = null;
      clearTimeout(expired);
    }
    for (const connection of this.#connections) {
      this.#drop(connection);
    }
    await this.#closed;
  }

  #drop(connection: Connection): void {
    connection.client.destroy();
    connection.onward?.destroy();
  }

  #release(connection: Connection): void {
    if (--connection.open > 0) {
      return;
    }
    clearTimeout(connection.idle ?? undefined);
    this.#connections.delete(connection);
    if (this.#connections.size === 0) {
      this.#emptied?.();
    }
  }

  // A caller that has not shown the key yet gets few places and little time,
  // so that a program without the key cannot keep the tunnels' places taken.
  #accept(client: net.Socket): void {
    if (
      this.#quiesced ||
      this.#waiting >= (this.#options.waitingLimit ?? waitingLimit) ||
      this.#connections.size >=
        (this.#options.connectionLimit ?? connectionLimit)
    ) {
      client.destroy();
      return;
    }
    const connection: Connection = {
      client,
      onward: null,
      intercepted: false,
      waiting: true,
      open: 1,
      idle: null,
    };
    this.#connections.add(connection);
    this.#waiting++;
    const admitted = (): void => {
      if (!connection.waiting) {
        return;
      }
      connection.waiting = false;
      this.#waiting--;
    };
    const late = setTimeout(() => {
      client.destroy();
    }, this.#options.headTimeout ?? headTimeout);
    client.once("close", () => {
      clearTimeout(late);
      admitted();
      if (connection.onward !== null) {
        finish(connection.onward);
      }
      this.#release(connection);
    });
    client.on("error", () => {
      client.destroy();
    });
    // The socket is half-open, so a caller that ends before its head is
    // complete would otherwise keep its place until the head is late.
    const gone = (): void => {
      client.destroy();
    };
    client.once("end", gone);
    let head: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const request = parseHead(head);
      if (request === null) {
        return;
      }
      clearTimeout(late);
      client.off("data", onData);
      client.off("end", gone);
      client.pause();
      if (request === "malformed") {
        this.#refuse(client, 400, "the cog proxy could not read the request");
        return;
      }
      const decision = decide(request, this.key);
      if (decision.kind === "refuse") {
        this.#refuse(client, decision.status, decision.message);
        return;
      }
      admitted();
      connection.intercepted = decision.intercepted;
      this.#tunnel(connection, decision.host, request.rest);
    };
    client.on("data", onData);
  }

  // The socket is half-open, so ending it would leave it readable for as long
  // as the caller likes.
  #refuse(
    client: net.Socket,
    status: keyof typeof statusText,
    message: string,
  ): void {
    if (client.destroyed) {
      return;
    }
    client.end(refusal(status, message), () => {
      client.destroy();
    });
  }

  #tunnel(connection: Connection, host: string, rest: Buffer): void {
    const { client } = connection;
    const onward = connection.intercepted
      ? net.connect({ path: this.socket, allowHalfOpen: true })
      : (this.#options.connect ?? toInternet)(host);
    connection.onward = onward;
    connection.open++;
    let connected = false;
    let late = false;
    const slow = setTimeout(() => {
      late = true;
      onward.destroy();
    }, this.#options.connectTimeout ?? connectTimeout);
    // A tunnel whose two ends are both silent this long is one that a peer
    // left without closing, as after the Mac slept, or half of one whose
    // other half never ends.
    const idle = setTimeout(() => {
      this.#drop(connection);
    }, this.#options.idleTimeout ?? idleTimeout);
    connection.idle = idle;
    const active = (): void => {
      idle.refresh();
    };
    onward.once("connect", () => {
      connected = true;
      clearTimeout(slow);
      if (client.destroyed) {
        onward.destroy();
        return;
      }
      for (const socket of [client, onward]) {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, keepAliveDelay);
        socket.on("data", active);
      }
      client.write(established);
      if (rest.length > 0) {
        onward.write(rest);
      }
      client.pipe(onward);
      onward.pipe(client);
    });
    onward.on("error", () => {
      onward.destroy();
    });
    onward.once("close", () => {
      clearTimeout(slow);
      if (connected) {
        finish(client);
      } else if (late) {
        this.#refuse(
          client,
          504,
          "the cog proxy could not reach the host in time",
        );
      } else {
        this.#refuse(client, 502, "the cog proxy could not reach the host");
      }
      this.#release(connection);
    });
  }
}
