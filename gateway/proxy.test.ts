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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  authorized,
  ConnectProxy,
  decide,
  isIntercepted,
  parseHead,
  parseTarget,
  proxyUrl,
  readProxyUrl,
  refusal,
  type Decision,
  type ProxyOptions,
  type ProxyRequest,
} from "./proxy.ts";

const key = "k".repeat(43);
const wrongKey = "j".repeat(43);

function basicFor(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
}

function scratch(prefix = "cog-proxy-"): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function shortDirectory(): string {
  const directory = mkdtempSync("/tmp/cpx-");
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function freePort(host: string): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0 }, resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

test("proxyUrl round-trips through readProxyUrl, with a trailing newline", () => {
  const file = path.join(scratch(), "proxy-url");
  writeFileSync(file, `${proxyUrl(key, 4242)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.deepEqual(readProxyUrl(file, 4242), { kind: "key", key });
});

test("proxyUrl names the production port by default and brackets ::1", () => {
  assert.equal(proxyUrl(key), `http://cog:${key}@[::1]:17443`);
  const file = path.join(scratch(), "proxy-url");
  writeFileSync(file, proxyUrl(key), { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.deepEqual(readProxyUrl(file), { kind: "key", key });
});

const base = "k".repeat(43);
const unusable: [string, string][] = [
  ["another port", `http://cog:${base}@[::1]:4243`],
  ["another user", `http://root:${base}@[::1]:4242`],
  ["127.0.0.1", `http://cog:${base}@127.0.0.1:4242`],
  ["localhost", `http://cog:${base}@localhost:4242`],
  ["https scheme", `https://cog:${base}@[::1]:4242`],
  ["key too short", `http://cog:${"k".repeat(42)}@[::1]:4242`],
  ["key too long", `http://cog:${"k".repeat(44)}@[::1]:4242`],
  ["character outside base64url", `http://cog:${"k".repeat(42)}+@[::1]:4242`],
  ["padding character", `http://cog:${"k".repeat(42)}=@[::1]:4242`],
  ["trailing path", `http://cog:${base}@[::1]:4242/`],
  ["no key", "http://cog:@[::1]:4242"],
  ["not a URL", base],
];
for (const [title, content] of unusable) {
  test(`readProxyUrl refuses ${title} and says nothing of the content`, () => {
    const file = path.join(scratch(), "proxy-url");
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
    const result = readProxyUrl(file, 4242);
    assert.deepEqual(result, {
      kind: "unusable",
      reason: "does not hold a proxy URL that this cog wrote",
    });
  });
}

for (const mode of [0o640, 0o604, 0o660, 0o606, 0o666, 0o644]) {
  test(`readProxyUrl refuses mode ${mode.toString(8)}`, () => {
    const file = path.join(scratch(), "proxy-url");
    writeFileSync(file, proxyUrl(key, 4242));
    chmodSync(file, mode);
    assert.deepEqual(readProxyUrl(file, 4242), {
      kind: "unusable",
      reason: "is open to other users",
    });
  });
}

test("readProxyUrl accepts mode 400", () => {
  const file = path.join(scratch(), "proxy-url");
  writeFileSync(file, proxyUrl(key, 4242));
  chmodSync(file, 0o400);
  assert.deepEqual(readProxyUrl(file, 4242), { kind: "key", key });
});

test("readProxyUrl refuses a directory", () => {
  const directory = path.join(scratch(), "proxy-url");
  mkdirSync(directory);
  assert.deepEqual(readProxyUrl(directory, 4242), {
    kind: "unusable",
    reason: "is not a regular file",
  });
});

test("readProxyUrl calls a missing file missing", () => {
  assert.deepEqual(readProxyUrl(path.join(scratch(), "none"), 4242), {
    kind: "missing",
  });
});

test("readProxyUrl does not echo an unusable file's key in a reason", () => {
  const file = path.join(scratch(), "proxy-url");
  writeFileSync(file, `http://cog:${key}@[::1]:1`, { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.ok(!JSON.stringify(readProxyUrl(file, 4242)).includes(key));
  chmodSync(file, 0o644);
  assert.ok(!JSON.stringify(readProxyUrl(file, 1)).includes(key));
});

function head(lines: string[], terminator = "\r\n\r\n"): Buffer {
  return Buffer.from(lines.join("\r\n") + terminator, "latin1");
}

const connectLine = "CONNECT example.com:443 HTTP/1.1";

test("parseHead waits for the end of the head", () => {
  assert.equal(parseHead(Buffer.alloc(0)), null);
  assert.equal(parseHead(Buffer.from(connectLine)), null);
  assert.equal(parseHead(Buffer.from(`${connectLine}\r\nHost: a\r\n`)), null);
  assert.equal(parseHead(Buffer.from(`${connectLine}\r\nHost: a\r\n\r`)), null);
});

test("parseHead returns the bytes after the head as rest", () => {
  const parsed = parseHead(
    Buffer.concat([
      head([connectLine, "Host: example.com:443"]),
      Buffer.from([0x16, 0x03, 0x01, 0x00]),
    ]),
  );
  assert.ok(parsed !== null && parsed !== "malformed");
  assert.equal(parsed.method, "CONNECT");
  assert.equal(parsed.target, "example.com:443");
  assert.deepEqual(parsed.authorization, []);
  assert.deepEqual([...parsed.rest], [0x16, 0x03, 0x01, 0x00]);
});

test("parseHead takes a head with no headers and an empty rest", () => {
  const parsed = parseHead(head([connectLine]));
  assert.ok(parsed !== null && parsed !== "malformed");
  assert.equal(parsed.rest.length, 0);
});

test("parseHead accepts HTTP/1.0", () => {
  const parsed = parseHead(head(["CONNECT a:443 HTTP/1.0"]));
  assert.ok(parsed !== null && parsed !== "malformed");
});

const malformed: [string, Buffer][] = [
  ["a lowercase method", head(["connect a:443 HTTP/1.1"])],
  ["HTTP/2.0", head(["CONNECT a:443 HTTP/2.0"])],
  ["HTTP/1.2", head(["CONNECT a:443 HTTP/1.2"])],
  ["no version", head(["CONNECT a:443"])],
  ["two spaces in the request line", head(["CONNECT  a:443 HTTP/1.1"])],
  ["an empty request line", head([""])],
  [
    "a bare LF in a header",
    Buffer.from(`${connectLine}\r\nHost: a\nX: b\r\n\r\n`, "latin1"),
  ],
  [
    "a bare LF after the request line",
    Buffer.from(`${connectLine}\nHost: a\r\n\r\n`, "latin1"),
  ],
  ["a NUL in a value", head([connectLine, "X: a\0b"])],
  ["a control character in a value", head([connectLine, "X: a\u{1}b"])],
  ["a DEL in a value", head([connectLine, "X: a\u{7F}b"])],
  [
    "a control character in the request line",
    head(["CONNECT a:4\u{1}43 HTTP/1.1"]),
  ],
  ["a byte above ASCII in a value", head([connectLine, "X: café"])],
  ["an obs-fold continuation", head([connectLine, "X: a", " b"])],
  ["a tab-started continuation", head([connectLine, "X: a", "\tb"])],
  ["whitespace before the colon", head([connectLine, "Host : a"])],
  ["a header with no colon", head([connectLine, "Host"])],
  ["an empty header name", head([connectLine, ": a"])],
  [
    "a head over the limit with its terminator",
    head([connectLine, `X: ${"a".repeat(8200)}`]),
  ],
  [
    "a head over the limit with no terminator",
    Buffer.from(`${connectLine}\r\nX: ${"a".repeat(8200)}`, "latin1"),
  ],
];

for (const [title, buffer] of malformed) {
  test(`parseHead calls ${title} malformed`, () => {
    assert.equal(parseHead(buffer), "malformed");
  });
}

test("parseHead keeps waiting on a head of exactly the limit and refuses one byte more", () => {
  const prefix = `${connectLine}\r\nX: `;
  const exact = Buffer.from(
    `${prefix}${"a".repeat(8192 - prefix.length)}\r\n\r\n`,
    "latin1",
  );
  assert.equal(exact.indexOf("\r\n\r\n"), 8192);
  const parsed = parseHead(exact);
  assert.ok(parsed !== null && parsed !== "malformed");
  const over = Buffer.from(
    `${prefix}${"a".repeat(8193 - prefix.length)}\r\n\r\n`,
    "latin1",
  );
  assert.equal(parseHead(over), "malformed");
  assert.equal(parseHead(Buffer.alloc(8192, 0x61)), null);
  assert.equal(parseHead(Buffer.alloc(8193, 0x61)), "malformed");
});

test("parseHead refuses a long run of spaces that ends in a refused byte without a long search", () => {
  const spaces = Buffer.from(
    `${connectLine}\r\nX:${" ".repeat(8000)}\u{1}\r\n\r\n`,
    "latin1",
  );
  const started = performance.now();
  for (let count = 0; count < 20; count++) {
    assert.equal(parseHead(spaces), "malformed");
  }
  assert.ok(performance.now() - started < 150, "the head held the event loop");
});

test("parseHead does not end a head that only has LF line endings", () => {
  assert.equal(parseHead(Buffer.from(`${connectLine}\nHost: a\n\n`)), null);
});

test("parseHead collects Proxy-Authorization whatever its case, in order and trimmed", () => {
  const parsed = parseHead(
    head([
      connectLine,
      "Proxy-Authorization: Basic one",
      "PROXY-AUTHORIZATION:Basic two  ",
      "proxy-authorization: \tBasic three",
      "X-Proxy-Authorization: Basic no",
    ]),
  );
  assert.ok(parsed !== null && parsed !== "malformed");
  assert.deepEqual(parsed.authorization, [
    "Basic one",
    "Basic two",
    "Basic three",
  ]);
});

function authorization(...values: string[]): string[] {
  return values;
}

test("authorized accepts the right key", () => {
  assert.equal(authorized(authorization(basicFor("cog", key)), key), true);
});

test("authorized accepts the scheme in any case and with extra spaces", () => {
  const token = basicFor("cog", key).slice("Basic ".length);
  for (const scheme of ["basic", "BASIC", "bAsIc"]) {
    assert.equal(authorized([`${scheme} ${token}`], key), true, scheme);
  }
  assert.equal(authorized([`Basic   ${token}`], key), true);
});

const refused: [string, string[]][] = [
  ["a wrong key of the same length", [basicFor("cog", wrongKey)]],
  ["a key one character short", [basicFor("cog", key.slice(1))]],
  ["a key one character long", [basicFor("cog", `${key}k`)]],
  ["a key much longer", [basicFor("cog", key.repeat(100))]],
  ["an empty key", [basicFor("cog", "")]],
  ["no header", []],
  ["two headers both right", [basicFor("cog", key), basicFor("cog", key)]],
  [
    "a wrong one then a right one",
    [basicFor("cog", wrongKey), basicFor("cog", key)],
  ],
  ["another user name", [basicFor("root", key)]],
  ["an empty user name", [basicFor("", key)]],
  ["no colon", [`Basic ${Buffer.from(`cog${key}`).toString("base64")}`]],
  ["a value that is not base64", ["Basic !!!!"]],
  ["a Bearer scheme", [`Bearer ${key}`]],
  [
    "a Bearer scheme with the encoded pair",
    [`Bearer ${Buffer.from(`cog:${key}`).toString("base64")}`],
  ],
  ["the bare key", [key]],
  ["the scheme alone", ["Basic"]],
  ["the scheme and an empty token", ["Basic "]],
  ["an empty value", [""]],
];

for (const [title, values] of refused) {
  test(`authorized refuses ${title}`, () => {
    assert.equal(authorized(values, key), false);
  });
}

const targets: [string, { host: string; port: number } | null][] = [
  ["example.com:443", { host: "example.com", port: 443 }],
  ["Example.COM:443", { host: "Example.COM", port: 443 }],
  ["api.anthropic.com.:443", { host: "api.anthropic.com.", port: 443 }],
  ["1.2.3.4:443", { host: "1.2.3.4", port: 443 }],
  ["host_name-1:8080", { host: "host_name-1", port: 8080 }],
  ["[::1]:443", { host: "::1", port: 443 }],
  ["[2001:db8::1]:8443", { host: "2001:db8::1", port: 8443 }],
  ["[::ffff:1.2.3.4]:443", { host: "::ffff:1.2.3.4", port: 443 }],
  ["example.com:0", { host: "example.com", port: 0 }],
  ["[fe80::1%25en0]:443", null],
  ["[fe80::1%en0]:443", null],
  ["example.com", null],
  ["example.com:", null],
  ["example.com:44a", null],
  ["example.com:+443", null],
  ["example.com:-1", null],
  ["example.com:443443", null],
  ["example.com:4 43", null],
  [":443", null],
  ["", null],
  ["[::1]", null],
  ["[]:443", null],
  ["[:]:443", null],
  ["[::1]:", null],
  ["[host]:443", null],
  ["user@example.com:443", null],
  ["user:pw@example.com:443", null],
  ["example.com:443/path", null],
  ["example.com/x:443", null],
  ["http://example.com:443", null],
  ["-example.com:443", null],
  [".example.com:443", null],
  ["exa mple.com:443", null],
  ["example.com:443:443", null],
  [`${"a".repeat(254)}:443`, null],
];

for (const [target, expected] of targets) {
  test(`parseTarget(${JSON.stringify(target.slice(0, 40))}) is ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(parseTarget(target), expected);
  });
}

test("isIntercepted takes the name in any case with at most one trailing dot", () => {
  for (const name of [
    "api.anthropic.com",
    "API.Anthropic.COM",
    "api.anthropic.com.",
    "Api.Anthropic.Com.",
  ]) {
    assert.equal(isIntercepted(name), true, name);
  }
});

test("isIntercepted refuses other names, suffixes and prefixes", () => {
  for (const name of [
    "",
    "api.anthropic.com..",
    "xapi.anthropic.com",
    "api.anthropic.comx",
    "api.anthropic.com.evil.test",
    "evil.api.anthropic.com",
    "anthropic.com",
    "api-anthropic.com",
    "api.fireworks.ai",
    "192.0.2.1",
  ]) {
    assert.equal(isIntercepted(name), false, name);
  }
});

function request(
  method: string,
  target: string,
  ...values: string[]
): ProxyRequest {
  return { method, target, authorization: values, rest: Buffer.alloc(0) };
}

const good = basicFor("cog", key);
function statusOf(decision: Decision): number | null {
  return decision.kind === "refuse" ? decision.status : null;
}

test("decide answers 407 to every request without the key, in front of every other check", () => {
  for (const [method, target] of [
    ["CONNECT", "example.com:443"],
    ["GET", "http://example.com/"],
    ["GET", "example.com:443"],
    ["CONNECT", "not a target"],
    ["CONNECT", "example.com:80"],
    ["POST", ""],
  ] as const) {
    for (const values of [[], [basicFor("cog", wrongKey)], [good, good]]) {
      const decision = decide(request(method, target, ...values), key);
      assert.equal(statusOf(decision), 407);
    }
  }
});

test("decide answers 405 to a method other than CONNECT, before it reads the target", () => {
  for (const [method, target] of [
    ["GET", "example.com:443"],
    ["GET", "not a target"],
    ["POST", "example.com:80"],
    ["connect", "example.com:443"],
  ] as const) {
    const decision = decide(request(method, target, good), key);
    assert.equal(statusOf(decision), 405, method);
  }
});

test("decide answers 400 to a bad target, before it reads the port", () => {
  for (const target of [
    "example.com",
    "example.com:",
    "[fe80::1%25en0]:443",
    "user@example.com:443",
    "example.com:443/x",
    "example.com:123456",
  ]) {
    const decision = decide(request("CONNECT", target, good), key);
    assert.equal(statusOf(decision), 400, target);
  }
});

test("decide answers 403 to a port other than 443", () => {
  for (const target of [
    "example.com:80",
    "example.com:0",
    "example.com:8443",
    "[::1]:22",
    "api.anthropic.com:80",
    "example.com:99999",
  ]) {
    const decision = decide(request("CONNECT", target, good), key);
    assert.equal(statusOf(decision), 403, target);
  }
});

test("decide tunnels to port 443 and marks only the intercepted name", () => {
  assert.deepEqual(decide(request("CONNECT", "example.com:443", good), key), {
    kind: "tunnel",
    host: "example.com",
    intercepted: false,
  });
  assert.deepEqual(decide(request("CONNECT", "[::1]:443", good), key), {
    kind: "tunnel",
    host: "::1",
    intercepted: false,
  });
  assert.deepEqual(
    decide(request("CONNECT", "API.anthropic.com.:443", good), key),
    { kind: "tunnel", host: "API.anthropic.com.", intercepted: true },
  );
  assert.deepEqual(
    decide(request("CONNECT", "api.anthropic.com.evil.test:443", good), key),
    { kind: "tunnel", host: "api.anthropic.com.evil.test", intercepted: false },
  );
});

test("refusal sends Proxy-Authenticate only with 407 and states its own length", () => {
  const text = refusal(407, "need it");
  assert.match(text, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/u);
  assert.match(text, /\r\nProxy-Authenticate: Basic realm="cog"\r\n/u);
  assert.match(text, /\r\nConnection: close\r\n/u);
  assert.match(text, /\r\nContent-Length: 8\r\n/u);
  assert.ok(text.endsWith("\r\n\r\nneed it\n"));
  assert.ok(!refusal(403, "no").includes("Proxy-Authenticate"));
});

interface Watch {
  readonly socket: net.Socket;
  data(): Buffer;
  text(): string;
  body(): string;
  ended(): boolean;
  closed(): boolean;
  until(predicate: () => boolean, what: string, ms?: number): Promise<void>;
  gone(ms?: number): Promise<void>;
}

function watch(socket: net.Socket): Watch {
  let received = Buffer.alloc(0);
  let ended = false;
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of waiters) {
      waiter();
    }
  };
  socket.on("data", (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    wake();
  });
  socket.on("end", () => {
    ended = true;
    wake();
  });
  socket.on("close", () => {
    closed = true;
    wake();
  });
  socket.on("error", () => {
    wake();
  });
  const until = (
    predicate: () => boolean,
    what: string,
    ms = 5000,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!predicate()) {
          return;
        }

        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      waiters.add(check);
      check();
    });
  const text = (): string => received.toString("latin1");
  return {
    socket,
    data: () => received,
    text,
    body: () => text().slice(text().indexOf("\r\n\r\n") + 4),
    ended: () => ended,
    closed: () => closed,
    until,
    gone: (ms) => until(() => closed, "the socket to close", ms),
  };
}

function dial(
  port: number,
  { halfOpen = false }: { halfOpen?: boolean } = {},
): Watch {
  const socket = net.connect({ host: "::1", port, allowHalfOpen: halfOpen });
  onTestFinished(() => {
    socket.destroy();
  });
  return watch(socket);
}

async function dialed(port: number, halfOpen = false): Promise<Watch> {
  const client = dial(port, { halfOpen });
  await new Promise<void>((resolve, reject) => {
    client.socket.once("connect", resolve);
    client.socket.once("error", reject);
  });
  return client;
}

function connectHead(
  target = "example.com:443",
  credential: string | null = good,
  method = "CONNECT",
): string {
  return [
    `${method} ${target} HTTP/1.1`,
    `Host: ${target}`,
    ...(credential === null ? [] : [`Proxy-Authorization: ${credential}`]),
    "",
    "",
  ].join("\r\n");
}

function ignore(): void {
  // An error on a socket shows to the tests as its close.
}

function sink(socket: net.Socket): void {
  socket.on("data", ignore);
  socket.on("end", () => {
    socket.end();
  });
}

function reset(socket: net.Socket): void {
  socket.resetAndDestroy();
}

interface Stub {
  readonly port: number;
  readonly sockets: net.Socket[];
}

async function tcpStub(
  onConnection: (socket: net.Socket) => void,
): Promise<Stub> {
  const sockets: net.Socket[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on("error", ignore);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  onTestFinished(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  return { sockets, port: (server.address() as net.AddressInfo).port };
}

function connectTo(port: number): (host: string) => net.Socket {
  return () => net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
}

function echo(prefix: string): (socket: net.Socket) => void {
  return (socket) => {
    socket.on("data", (chunk: Buffer) => {
      socket.write(`${prefix}${chunk.toString("latin1")}`);
    });
    socket.on("end", () => {
      socket.end();
    });
  };
}

async function unixStub(
  socketPath: string,
  onConnection: (socket: net.Socket) => void,
): Promise<{ connections: net.Socket[] }> {
  const connections: net.Socket[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.push(socket);
    socket.on("error", ignore);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  onTestFinished(() => {
    for (const socket of connections) {
      socket.destroy();
    }
    server.close();
  });
  return { connections };
}

async function startProxy(
  options: Partial<ProxyOptions> = {},
): Promise<ConnectProxy> {
  const proxy = new ConnectProxy({
    key,
    socket: path.join(shortDirectory(), "u.sock"),
    port: 0,
    ...options,
  });
  await proxy.listen();
  onTestFinished(async () => {
    await proxy.close();
  });
  return proxy;
}

async function tunnel(
  proxy: ConnectProxy,
  target = "example.com:443",
  halfOpen = false,
): Promise<Watch> {
  const client = await dialed(proxy.port, halfOpen);
  client.socket.write(connectHead(target));
  await client.until(
    () => client.text().includes("\r\n\r\n") || client.closed(),
    "the proxy's answer",
  );
  assert.match(client.text(), /^HTTP\/1\.1 200 /u);
  return client;
}

async function assertServes(proxy: ConnectProxy): Promise<void> {
  const client = await tunnel(proxy);
  client.socket.write("again");
  await client.until(() => client.body().includes("again"), "an echo");
  client.socket.destroy();
}

async function retry(attempt: () => Promise<void> | void): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("a blind tunnel carries bytes both ways", async () => {
  const stub = await tcpStub((socket) => {
    socket.write("hello from the stub\n");
    echo("echo:")(socket);
  });
  const hosts: string[] = [];
  const proxy = await startProxy({
    connect: (host) => {
      hosts.push(host);
      return connectTo(stub.port)(host);
    },
  });
  const client = await tunnel(proxy);
  assert.deepEqual(hosts, ["example.com"]);
  await client.until(
    () => client.body().includes("hello from the stub\n"),
    "the stub's greeting",
  );
  client.socket.write("ping");
  await client.until(() => client.body().includes("echo:ping"), "the echo");
  assert.ok(!client.text().includes(key));
});

test("bytes in the same write as the head reach the other end after the answer", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await dialed(proxy.port);
  client.socket.write(`${connectHead()}early bytes`);
  await client.until(
    () => client.body().includes("echo:early bytes"),
    "the echo of the bytes sent with the head",
  );
  assert.match(
    client.text(),
    /^HTTP\/1\.1 200 Connection Established\r\n\r\n/u,
  );
});

test("bytes sent after the head, while the other end is still being reached, are not lost", async () => {
  const stub = await tcpStub(echo("echo:"));
  const reach = Promise.withResolvers<undefined>();
  const proxy = await startProxy({
    connect: () => {
      const socket = new net.Socket({ allowHalfOpen: true });
      void reach.promise.then(() => {
        socket.connect({ host: "127.0.0.1", port: stub.port });
      });
      return socket;
    },
  });
  const client = await dialed(proxy.port);
  client.socket.write(connectHead());
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.socket.write("late bytes");
  await new Promise((resolve) => setTimeout(resolve, 100));
  reach.resolve(undefined);
  await client.until(
    () => client.body().includes("echo:late bytes"),
    "the echo of the bytes sent before the connection",
  );
});

test("an established tunnel outlives the connect timeout", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    connectTimeout: 100,
    connect: connectTo(stub.port),
  });
  const client = await tunnel(proxy);
  await new Promise((resolve) => setTimeout(resolve, 400));
  client.socket.write("still here");
  await client.until(
    () => client.body().includes("echo:still here"),
    "an echo after the connect timeout",
  );
});

test("a client that keeps its end open after the upstream has ended and reset is destroyed once what is left has been written", async () => {
  const stub = await tcpStub((socket) => {
    socket.end("bye");
    setTimeout(() => {
      reset(socket);
    }, 100);
  });
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await tunnel(proxy, "example.com:443", true);
  await client.until(() => client.body().includes("bye"), "the last bytes");
  await new Promise((resolve) => setTimeout(resolve, 400));
  client.socket.write("late");
  await client.gone();
});

test("a client that half-closes after sending still receives the answer", async () => {
  const stub = await tcpStub((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      socket.end(`answer to ${Buffer.concat(chunks).toString("latin1")}`);
    });
  });
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await tunnel(proxy, "example.com:443", true);
  client.socket.end("the question");
  await client.until(
    () => client.body().includes("answer to the question"),
    "the answer after the half-close",
  );
  await client.until(() => client.ended(), "the end of the answer");
});

function pattern(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    buffer[index] = (index * 31 + (index >>> 8)) & 0xff;
  }
  return buffer;
}

function sha(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

test("a large answer followed by the stub's close arrives complete at a slow client", async () => {
  const answer = pattern(8 * 1024 * 1024);
  const stub = await tcpStub((socket) => {
    socket.end(answer, () => {
      socket.destroy();
    });
  });
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await dialed(proxy.port);
  const chunks: Buffer[] = [];
  client.socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    client.socket.pause();
    setTimeout(() => {
      client.socket.resume();
    }, 2);
  });
  client.socket.write(connectHead());
  await client.gone(60_000);
  const all = Buffer.concat(chunks);
  const start = all.indexOf("\r\n\r\n") + 4;
  assert.equal(all.length - start, answer.length);
  assert.equal(sha(all.subarray(start)), sha(answer));
}, 90_000);

test("a large upload followed by the client's close arrives complete at a slow stub", async () => {
  const upload = pattern(8 * 1024 * 1024);
  const { promise: arrived, resolve: finished } =
    Promise.withResolvers<Buffer>();
  const stub = await tcpStub((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      socket.pause();
      setTimeout(() => {
        socket.resume();
      }, 2);
    });
    socket.on("end", () => {
      finished(Buffer.concat(chunks));
      socket.end();
    });
  });
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await tunnel(proxy);
  client.socket.write(upload, () => {
    client.socket.destroy();
  });
  const received = await Promise.race([
    arrived,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("the upload did not arrive"));
      }, 60_000),
    ),
  ]);
  assert.equal(received.length, upload.length);
  assert.equal(sha(received), sha(upload));
}, 90_000);

test("the intercepted name goes to the Unix socket and other names to the connect seam", async () => {
  const directory = shortDirectory();
  const socket = path.join(directory, "m.sock");
  const unix = await unixStub(socket, (connection) => {
    connection.write("unix\n");
  });
  const tcp = await tcpStub((connection) => {
    connection.write("tcp\n");
  });
  const hosts: string[] = [];
  const proxy = await startProxy({
    socket,
    connect: (host) => {
      hosts.push(host);
      return connectTo(tcp.port)(host);
    },
  });
  const intercepted = [
    "api.anthropic.com",
    "API.Anthropic.COM",
    "api.anthropic.com.",
  ];
  const others = [
    "api.anthropic.com..",
    "xapi.anthropic.com",
    "api.anthropic.com.evil.test",
    "api.fireworks.ai",
    "192.0.2.1",
  ];
  for (const name of intercepted) {
    const client = await tunnel(proxy, `${name}:443`);
    await client.until(() => client.body() === "unix\n", `unix for ${name}`);
    client.socket.destroy();
  }
  assert.equal(unix.connections.length, intercepted.length);
  assert.deepEqual(hosts, []);
  for (const name of others) {
    const client = await tunnel(proxy, `${name}:443`);
    await client.until(() => client.body() === "tcp\n", `tcp for ${name}`);
    client.socket.destroy();
  }
  assert.equal(unix.connections.length, intercepted.length);
  assert.deepEqual(hosts, others);
});

const refusals: [string, string, number, string | null][] = [
  ["no key", connectHead("example.com:443", null), 407, null],
  [
    "a wrong key",
    connectHead("example.com:443", basicFor("cog", wrongKey)),
    407,
    wrongKey,
  ],
  [
    "another user",
    connectHead("example.com:443", basicFor("root", key)),
    407,
    null,
  ],
  [
    "a GET without the key",
    connectHead("http://example.com/", null, "GET"),
    407,
    null,
  ],
  [
    "a GET with the key",
    connectHead("example.com:443", good, "GET"),
    405,
    null,
  ],
  ["port 80", connectHead("example.com:80"), 403, null],
  ["a bad target", connectHead("example.com"), 400, null],
  ["a malformed head", "connect example.com:443 HTTP/1.1\r\n\r\n", 400, null],
  [
    "a head with a NUL",
    `CONNECT a:443 HTTP/1.1\r\nX: a\0b\r\nProxy-Authorization: ${good}\r\n\r\n`,
    400,
    null,
  ],
];

for (const [title, sent, status, secret] of refusals) {
  test(`the proxy answers ${title} with ${String(status)}, closes, and does not echo the key`, async () => {
    const hosts: string[] = [];
    const proxy = await startProxy({
      connect: (host) => {
        hosts.push(host);
        return net.connect({ host: "127.0.0.1", port: 1 });
      },
    });
    const client = await dialed(proxy.port);
    client.socket.write(sent);
    await client.gone();
    assert.match(
      client.text(),
      new RegExp(String.raw`^HTTP/1\.1 ${String(status)} `, "u"),
    );
    assert.equal(
      client.text().includes("Proxy-Authenticate: Basic realm="),
      status === 407,
    );
    for (const text of [
      key,
      good,
      Buffer.from(`cog:${key}`).toString("base64"),
    ]) {
      assert.ok(!client.text().includes(text));
    }
    if (secret !== null) {
      assert.ok(!client.text().includes(secret));
    }
    assert.deepEqual(hosts, []);
  });
}

test("a head over the limit with no end is answered 400 and closed", async () => {
  const proxy = await startProxy();
  const client = await dialed(proxy.port);
  client.socket.write(`${connectLine}\r\nX: ${"a".repeat(9000)}`);
  await client.gone();
  assert.match(client.text(), /^HTTP\/1\.1 400 /u);
});

test("a connection that sends nothing is closed after the head timeout", async () => {
  const proxy = await startProxy({ headTimeout: 100 });
  const silent = await dialed(proxy.port);
  await silent.gone();
  assert.equal(silent.data().length, 0);
  const partial = await dialed(proxy.port);
  partial.socket.write("CONNECT example.com:443 HTTP/1.1\r\n");
  await partial.gone();
});

test("a head that completes in time is not cut off by the head timeout", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    headTimeout: 1000,
    connect: connectTo(stub.port),
  });
  const client = await tunnel(proxy);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  client.socket.write("late");
  await client.until(() => client.body().includes("echo:late"), "an echo");
});

test("a connect that takes too long is answered 504", async () => {
  const sockets: net.Socket[] = [];
  const proxy = await startProxy({
    connectTimeout: 100,
    connect: () => {
      const socket = new net.Socket({ allowHalfOpen: true });
      sockets.push(socket);
      return socket;
    },
  });
  const client = await dialed(proxy.port);
  client.socket.write(connectHead());
  await client.gone();
  assert.match(client.text(), /^HTTP\/1\.1 504 /u);
  assert.equal(sockets[0]?.destroyed, true);
});

test("a refused connect is answered 502", async () => {
  const port = await freePort("127.0.0.1");
  const proxy = await startProxy({
    connect: () =>
      net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }),
  });
  const client = await dialed(proxy.port);
  client.socket.write(connectHead());
  await client.gone();
  assert.match(client.text(), /^HTTP\/1\.1 502 /u);
});

test("a missing Unix socket for the intercepted name is answered 502", async () => {
  const proxy = await startProxy();
  const client = await dialed(proxy.port);
  client.socket.write(connectHead("api.anthropic.com:443"));
  await client.gone();
  assert.match(client.text(), /^HTTP\/1\.1 502 /u);
});

test("a client that resets during the head does not stop the proxy", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await dialed(proxy.port);
  client.socket.write("CONNECT example.com");
  reset(client.socket);
  await assertServes(proxy);
});

test("a client that resets during the connect does not stop the proxy and drops the onward socket", async () => {
  const stub = await tcpStub(echo("echo:"));
  const pending: net.Socket[] = [];
  let slow = true;
  const proxy = await startProxy({
    connectTimeout: 60_000,
    connect: (host) => {
      if (!slow) {
        return connectTo(stub.port)(host);
      }
      const socket = new net.Socket({ allowHalfOpen: true });
      pending.push(socket);
      return socket;
    },
  });
  const client = await dialed(proxy.port);
  client.socket.write(connectHead());
  await retry(() => {
    assert.equal(pending.length, 1);
  });
  reset(client.socket);
  await retry(() => {
    assert.equal(pending[0]?.destroyed, true);
  });
  slow = false;
  await assertServes(proxy);
});

test("a client that resets while piping does not stop the proxy and drops the stub's socket", async () => {
  const stub = await tcpStub((socket) => {
    socket.write(pattern(1024 * 1024));
    sink(socket);
  });
  const proxy = await startProxy({ connect: connectTo(stub.port) });
  const client = await tunnel(proxy);
  client.socket.write("something");
  reset(client.socket);
  await retry(() => {
    assert.equal(stub.sockets[0]?.destroyed, true);
  });
  const echoStub = await tcpStub(echo("echo:"));
  const other = await startProxy({ connect: connectTo(echoStub.port) });
  await assertServes(other);
});

test("with the quota of silent connections taken a further one is closed at once, an established tunnel keeps working, and a place returns", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    waitingLimit: 2,
    headTimeout: 60_000,
    connect: connectTo(stub.port),
  });
  const established = await tunnel(proxy);
  const first = await dialed(proxy.port);
  const second = await dialed(proxy.port);
  const third = await dialed(proxy.port);
  await third.gone();
  assert.equal(third.data().length, 0);
  assert.equal(first.closed(), false);
  assert.equal(second.closed(), false);
  established.socket.write("still");
  await established.until(
    () => established.body().includes("echo:still"),
    "the established tunnel's echo",
  );
  reset(first.socket);
  await retry(async () => {
    const fourth = await tunnel(proxy);
    fourth.socket.destroy();
  });
});

test("a refused request gives its place back", async () => {
  const proxy = await startProxy({ waitingLimit: 1, headTimeout: 60_000 });
  for (let index = 0; index < 3; index++) {
    const client = await dialed(proxy.port);
    client.socket.write(connectHead("example.com:443", null));
    await client.gone();
    assert.match(client.text(), /^HTTP\/1\.1 407 /u);
  }
});

test("a caller that ends before its head is complete is closed and gives its place back", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    waitingLimit: 1,
    headTimeout: 60_000,
    connect: connectTo(stub.port),
  });
  const silent = await dialed(proxy.port);
  silent.socket.end("CONNECT example.com:443 HTTP/1.1\r\n");
  await silent.gone();
  assert.equal(silent.data().length, 0);
  const next = await tunnel(proxy);
  next.socket.destroy();
});

test("the connection limit closes a further connection at once and returns a place when one leaves", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    connectionLimit: 2,
    connect: connectTo(stub.port),
  });
  const first = await tunnel(proxy);
  const second = await tunnel(proxy);
  const third = await dialed(proxy.port);
  third.socket.write(connectHead());
  await third.gone();
  assert.equal(third.data().length, 0);
  first.socket.write("one");
  await first.until(() => first.body().includes("echo:one"), "an echo");
  second.socket.destroy();
  await retry(async () => {
    const fourth = await tunnel(proxy);
    fourth.socket.destroy();
  });
});

test("the idle timeout closes both ends of a silent tunnel", async () => {
  const stub = await tcpStub(echo("echo:"));
  const proxy = await startProxy({
    idleTimeout: 200,
    connect: connectTo(stub.port),
  });
  const client = await tunnel(proxy);
  await client.gone();
  await retry(() => {
    assert.equal(stub.sockets[0]?.destroyed, true);
  });
});

for (const direction of ["client to stub", "stub to client"] as const) {
  test(`traffic from ${direction} postpones the idle timeout`, async () => {
    const stub = await tcpStub((socket) => {
      sink(socket);
    });
    const proxy = await startProxy({
      idleTimeout: 800,
      connect: connectTo(stub.port),
    });
    const client = await tunnel(proxy);
    let count = 0;
    for (let tick = 0; tick < 12; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (direction === "client to stub") {
        client.socket.write("x");
      } else {
        stub.sockets[0]?.write("x");
      }
      count++;
    }
    assert.equal(client.closed(), false);
    assert.equal(stub.sockets[0]?.destroyed, false);
    if (direction === "stub to client") {
      await client.until(
        () => client.body().length === count,
        "every byte from the stub",
      );
    }
    await client.gone();
    await retry(() => {
      assert.equal(stub.sockets[0]?.destroyed, true);
    });
  });
}

test("quiesce refuses new connections, ends blind tunnels and heads, and keeps intercepted tunnels", async () => {
  const directory = shortDirectory();
  const socket = path.join(directory, "m.sock");
  await unixStub(socket, echo("unix:"));
  const stub = await tcpStub(echo("tcp:"));
  const proxy = await startProxy({
    socket,
    headTimeout: 60_000,
    connect: connectTo(stub.port),
  });
  const blind = await tunnel(proxy);
  const intercepted = await tunnel(proxy, "api.anthropic.com:443");
  const silent = await dialed(proxy.port);
  const { port } = proxy;
  proxy.quiesce();
  proxy.quiesce();
  await blind.gone();
  await silent.gone();
  await retry(() => {
    assert.equal(stub.sockets[0]?.destroyed, true);
  });
  intercepted.socket.write("after");
  await intercepted.until(
    () => intercepted.body().includes("unix:after"),
    "the intercepted echo after quiesce",
  );
  assert.equal(intercepted.closed(), false);
  const late = net.connect({ host: "::1", port });
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    late.once("error", resolve);
  });
  assert.equal(error.code, "ECONNREFUSED");
  const closing = proxy.close();
  await intercepted.gone();
  await closing;
});

test("close destroys everything and resolves", async () => {
  const directory = shortDirectory();
  const socket = path.join(directory, "m.sock");
  const unix = await unixStub(socket, echo("unix:"));
  const stub = await tcpStub(echo("tcp:"));
  const proxy = new ConnectProxy({
    key,
    socket,
    port: 0,
    headTimeout: 60_000,
    connect: connectTo(stub.port),
  });
  await proxy.listen();
  onTestFinished(async () => {
    await proxy.close();
  });
  const blind = await tunnel(proxy);
  const intercepted = await tunnel(proxy, "api.anthropic.com:443");
  const silent = await dialed(proxy.port);
  await retry(() => {
    assert.equal(unix.connections.length, 1);
  });
  await Promise.race([
    proxy.close(),
    new Promise((_, reject) =>
      setTimeout(() => {
        reject(new Error("close did not resolve"));
      }, 5000),
    ),
  ]);
  await blind.gone();
  await intercepted.gone();
  await silent.gone();
  await retry(() => {
    assert.equal(unix.connections[0]?.destroyed, true);
    assert.equal(stub.sockets[0]?.destroyed, true);
  });
  await proxy.close();
});

async function stalledUpstream(
  options: Partial<ProxyOptions>,
): Promise<{ proxy: ConnectProxy; client: Watch; upstream: () => net.Socket }> {
  const stub = await tcpStub((socket) => {
    socket.pause();
    setTimeout(() => {
      socket.end();
    }, 100);
  });
  let reached: net.Socket | undefined;
  const proxy = await startProxy({
    ...options,
    connect: () => {
      const socket = connectTo(stub.port)("example.com");
      // A write that never completes stands for a peer that takes no more
      // bytes.
      Object.assign(socket, { _write: ignore });
      reached = socket;
      return socket;
    },
  });
  const client = await tunnel(proxy, "example.com:443", true);
  client.socket.end("a request body");
  await client.gone();
  return {
    proxy,
    client,
    upstream: () => {
      assert.ok(reached);
      return reached;
    },
  };
}

test("an upstream that takes no more bytes is dropped by the idle timeout once its client is gone", async () => {
  const { upstream } = await stalledUpstream({ idleTimeout: 300 });
  await retry(() => {
    assert.equal(upstream().destroyed, true);
  });
});

test("close destroys an upstream that takes no more bytes although its client is gone", async () => {
  const { proxy, upstream } = await stalledUpstream({});
  assert.equal(upstream().destroyed, false);
  await proxy.close();
  assert.equal(upstream().destroyed, true);
});

test("close before listen resolves", async () => {
  const proxy = new ConnectProxy({
    key,
    socket: path.join(shortDirectory(), "u.sock"),
    port: 0,
  });
  await Promise.race([
    proxy.close(),
    new Promise((_, reject) =>
      setTimeout(() => {
        reject(new Error("close did not resolve"));
      }, 5000),
    ),
  ]);
});

test("a listen that completes after close is refused and frees the port", async () => {
  const port = await freePort("::1");
  const proxy = new ConnectProxy({
    key,
    socket: path.join(shortDirectory(), "u.sock"),
    port,
  });
  const listening = proxy.listen();
  await proxy.close();
  await assert.rejects(listening, /closed before it listened/u);
  assert.equal((await startProxy({ port })).port, port);
});

test("listen rejects with EADDRINUSE when another listener holds the port", async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => {
    holder.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
  });
  onTestFinished(() => {
    holder.close();
  });
  const { port } = holder.address() as net.AddressInfo;
  const proxy = new ConnectProxy({
    key,
    socket: path.join(shortDirectory(), "u.sock"),
    port,
  });
  await assert.rejects(proxy.listen(), { code: "EADDRINUSE" });
  await proxy.close();
});

test("the listener is on ::1 only, so 127.0.0.1 on the same port is refused", async () => {
  const proxy = await startProxy();
  const refused = net.connect({ host: "127.0.0.1", port: proxy.port });
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    refused.once("error", resolve);
  });
  assert.equal(error.code, "ECONNREFUSED");
  const open = net.connect({ host: "::1", port: proxy.port });
  onTestFinished(() => {
    open.destroy();
  });
  await new Promise<void>((resolve) => {
    open.once("connect", resolve);
  });
});
