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
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { onTestFinished, test } from "bun:test";
import { Control, controlOptions, locations } from "../gateway/control.ts";
import { proxyPort, proxyUrl } from "../gateway/proxy.ts";
import { Gateway } from "../gateway/server.ts";
import type { Context } from "./commands/context.ts";
import { proxyCommand } from "./commands/proxy.ts";

const main = path.join(import.meta.dirname, "main.ts");
const token = "sk-ant-oat01-made-up-proxy-test-token";
const leftoverKey = "k".repeat(43);

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

interface Echo {
  hosts: string[];
  connect: (host: string) => net.Socket;
}

async function echoServer(): Promise<Echo> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  const hosts: string[] = [];
  onTestFinished(() => {
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
  });
  return {
    hosts,
    connect: (host) => {
      hosts.push(host);
      return net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    },
  };
}

type Pool = "usable" | "unconfigured" | "unusable";

async function fixture(pool: Pool = "usable") {
  const root = mkdtempSync("/tmp/cog-");
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    COG_ROOT: root,
    HOME: root,
    COG_PROXY_PORT: String(port),
  };
  delete env.COG_BASE;
  const where = locations(env);
  if (pool !== "unconfigured") {
    mkdirSync(where.pool, { recursive: true, mode: 0o700 });
    const account = path.join(where.pool, "work");
    writeFileSync(account, `${token}\n`, { mode: 0o600 });
    chmodSync(account, pool === "usable" ? 0o600 : 0o644);
  }
  const options = { ...controlOptions(env), actor: "tester" };
  const control = new Control(where, options);
  const closers: (() => Promise<void> | void)[] = [];
  onTestFinished(async () => {
    for (const close of closers.toReversed()) {
      await close();
    }
    control.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = async (
    args: string[],
    extra: Record<string, string> = {},
  ): Promise<Ran> => {
    const child = spawn(process.execPath, [main, ...args], {
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const status = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    return { status, stdout, stderr };
  };
  const daemon = async (connect?: Echo["connect"]): Promise<Gateway> => {
    const own = new Control(where, options);
    own.ensureSocketDirectory();
    const gateway = new Gateway(own.state, own.auth, {
      ...own.certificates(),
      adminSocket: where.admin,
      pool: where.pool,
      proxyFile: where.proxy,
      proxyPort: port,
      proxyGrace: 100,
      ...(connect === undefined ? {} : { proxyConnect: connect }),
    });
    await gateway.start();
    closers.push(async () => {
      await gateway.stop();
      own.close();
    });
    return gateway;
  };
  const stub = async (
    answer: (url: string, method: string) => [number, unknown],
  ): Promise<string[]> => {
    mkdirSync(where.state, { recursive: true, mode: 0o700 });
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(`${request.method ?? ""} ${request.url ?? ""}`);
      const [status, body] = answer(request.url ?? "", request.method ?? "");
      response.writeHead(status).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(where.admin, resolve);
    });
    closers.push(() => {
      server.close();
      server.closeAllConnections();
    });
    return seen;
  };
  return { root, port, env, where, control, run, daemon, stub };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function urlText(file: string, port: number): string | null {
  const text = readFileSync(file, "utf8");
  const match = new RegExp(
    String.raw`^http://cog:([A-Za-z0-9_-]{43})@\[::1\]:${String(port)}\n$`,
    "u",
  ).exec(text);
  return match === null ? null : (match[1] ?? null);
}

function keyOf(f: Fixture): string {
  const key = urlText(f.where.proxy, f.port);
  assert.notEqual(key, null, "the URL file holds a proxy URL");
  return key ?? "";
}

interface Tunnel {
  head: string;
  socket: net.Socket;
}

async function connectThrough(
  port: number,
  target: string,
  key: string,
): Promise<Tunnel> {
  const socket = net.connect({ host: "::1", port });
  onTestFinished(() => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const credentials = Buffer.from(`cog:${key}`).toString("base64");
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
  );
  let head = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) {
        return;
      }
      socket.off("data", onData);
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", resolve);
  });
  return { head, socket };
}

async function listens(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "::1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

function refused(f: Fixture): void {
  assert.equal(existsSync(f.where.proxy), false);
  assert.equal(f.control.state.byName("mac"), null);
}

// The Host differs from the tunnel's, so the gateway refuses the request
// itself and nothing leaves the Mac.
async function policyRefused(f: Fixture, key: string): Promise<string> {
  const tunnel = await connectThrough(f.port, "api.anthropic.com:443", key);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /u);
  const secure = tls.connect({
    socket: tunnel.socket,
    servername: "api.anthropic.com",
    ca: readFileSync(path.join(f.where.secrets, "ca.pem")),
  });
  let answer = "";
  secure.setEncoding("utf8");
  secure.on("data", (chunk: string) => {
    answer += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", () => {
      secure.write(
        "GET /v1/models HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n",
      );
    });
    secure.once("error", reject);
    secure.once("close", resolve);
  });
  return answer;
}

const usage = "usage: cog proxy enable|disable|status|logs [--follow|--all]";

function noUrl(...texts: string[]): void {
  for (const text of texts) {
    assert.ok(!text.includes("http://cog:"), text);
    assert.ok(!text.includes("@[::1]"), text);
  }
}

function requestId(answer: string): string {
  const id = /"request_id":"([0-9a-f-]+)"/u.exec(answer)?.[1];
  assert.notEqual(id, undefined, answer);
  return id ?? "";
}

function rows(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function enabled(pool: Pool = "usable") {
  const f = await fixture(pool);
  const echo = await echoServer();
  await f.daemon(echo.connect);
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 0, result.stderr);
  return { f, echo, result, key: keyOf(f) };
}

test("enable writes the URL file, registers the Mac and starts the listener, and says nothing of the key", async () => {
  const { f, echo, result, key } = await enabled();
  assert.equal(statSync(f.where.proxy).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(f.where.proxy, "utf8"),
    `${proxyUrl(key, f.port)}\n`,
  );
  const mac = f.control.state.byName("mac");
  assert.notEqual(mac, null);
  assert.equal(path.dirname(mac?.socket ?? ""), f.where.sockets);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes(`[::1]:${String(f.port)}`), result.stdout);
  assert.ok(result.stdout.includes(f.where.proxy), result.stdout);
  assert.ok(
    result.stdout.includes(`NODE_EXTRA_CA_CERTS=${f.where.proxyCa}\n`),
    result.stdout,
  );
  assert.equal(path.dirname(f.where.proxyCa), f.where.state);
  assert.deepEqual(
    readFileSync(f.where.proxyCa),
    readFileSync(path.join(f.where.secrets, "ca.pem")),
  );
  assert.equal(statSync(f.where.proxyCa).mode & 0o777, 0o600);
  assert.ok(
    result.stdout.includes("CLAUDE_CODE_OAUTH_TOKEN=cog\n"),
    result.stdout,
  );
  assert.ok(!result.stdout.includes(key), result.stdout);
  noUrl(result.stdout);
  const tunnel = await connectThrough(f.port, "example.com:443", key);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /u);
  const echoed = new Promise<string>((resolve) => {
    tunnel.socket.once("data", (chunk: Buffer) => {
      resolve(chunk.toString());
    });
  });
  tunnel.socket.write("ping");
  assert.equal(await echoed, "ping");
  assert.deepEqual(echo.hosts, ["example.com"]);
}, 60_000);

test("the enabled proxy refuses a key that is not the file's and carries api.anthropic.com to the Mac's instance", async () => {
  const { f, key } = await enabled();
  const wrong = await connectThrough(
    f.port,
    "example.com:443",
    key.replace(/^./u, key.startsWith("A") ? "B" : "A"),
  );
  assert.match(wrong.head, /^HTTP\/1\.1 407 /u);
  const answer = await policyRefused(f, key);
  assert.match(answer, /^HTTP\/1\.1 403 /u);
  assert.ok(!answer.includes(key));
}, 60_000);

test("status says where the proxy listens and as which instance", async () => {
  const { f } = await enabled();
  const mac = f.control.state.byName("mac");
  const status = await f.run(["proxy", "status"]);
  assert.deepEqual(status, {
    status: 0,
    stdout: `listening on [::1]:${String(f.port)} as ${mac?.id ?? ""}\n`,
    stderr: "",
  });
}, 60_000);

test("status fails when the CA copy is missing or is not the gateway's CA, and enable publishes it again", async () => {
  const { f } = await enabled();
  const certificate = readFileSync(f.where.proxyCa);
  const before = readFileSync(f.where.proxy, "utf8");
  const mac = f.control.state.byName("mac");
  for (const damage of [
    (): void => {
      rmSync(f.where.proxyCa);
    },
    (): void => {
      writeFileSync(f.where.proxyCa, "another certificate\n");
    },
  ]) {
    damage();
    assert.deepEqual(await f.run(["proxy", "status"]), {
      status: 1,
      stdout: "",
      stderr: `cog: the proxy is unusable: ${f.where.proxyCa} is not the gateway's CA certificate; run cog proxy enable\n`,
    });
    const again = await f.run(["proxy", "enable"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^the proxy is already enabled\n/u);
    assert.deepEqual(readFileSync(f.where.proxyCa), certificate);
    assert.equal((await f.run(["proxy", "status"])).status, 0);
  }
  assert.equal(readFileSync(f.where.proxy, "utf8"), before);
  assert.deepEqual(f.control.state.byName("mac"), mac);
}, 60_000);

test("disable with no gateway running still removes the file and the registration, and says that the gateway was not told", async () => {
  const f = await fixture();
  const gateway = await f.daemon();
  assert.equal((await f.run(["proxy", "enable"])).status, 0);
  const mac = f.control.state.byName("mac");
  await gateway.stop();
  const result = await f.run(["proxy", "disable"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^cog: the proxy is disabled here, but the gateway was not told \(.+\); it closes the proxy when it next starts or syncs\n$/u,
  );
  assert.equal(existsSync(f.where.proxy), false);
  assert.equal(existsSync(f.where.proxyCa), false);
  assert.equal(f.control.state.byId(mac?.id ?? "")?.disabled, true);
}, 60_000);

test("a second enable says so and changes neither the file nor the instance", async () => {
  const { f } = await enabled();
  const before = readFileSync(f.where.proxy, "utf8");
  const mac = f.control.state.byName("mac");
  const again = await f.run(["proxy", "enable"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^the proxy is already enabled\n/u);
  assert.equal(again.stderr, "");
  assert.equal(readFileSync(f.where.proxy, "utf8"), before);
  assert.deepEqual(f.control.state.byName("mac"), mac);
  noUrl(again.stdout);
  const key = keyOf(f);
  assert.ok(!again.stdout.includes(key));
}, 60_000);

const staleListening = {
  "no file and no registration": (): void => {
    // The gateway's answer is all that is left.
  },
  "a registration and no file": (f: Fixture): void => {
    f.control.state.register(
      "mac",
      path.join(f.where.sockets, "github-aa-11.sock"),
      "tester",
    );
  },
  "a file and no registration": (f: Fixture): void => {
    mkdirSync(f.where.secrets, { recursive: true, mode: 0o700 });
    writeFileSync(f.where.proxy, `${proxyUrl(leftoverKey, f.port)}\n`, {
      mode: 0o600,
    });
  },
};

for (const [name, leave] of Object.entries(staleListening)) {
  test(`enable does not call a proxy enabled when the gateway still answers listening and there is ${name}`, async () => {
    const f = await fixture();
    leave(f);
    const seen = await f.stub((url) => {
      if (url === "/pool") {
        return [200, { state: "usable", reason: null, accounts: [] }];
      }
      return [
        200,
        url === "/proxy" ? { state: "listening", reason: null } : { ok: true },
      ];
    });
    const result = await f.run(["proxy", "enable"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^the proxy is enabled on /u);
    assert.notEqual(urlText(f.where.proxy, f.port), null);
    assert.notEqual(keyOf(f), leftoverKey);
    assert.notEqual(f.control.state.byName("mac"), null);
    assert.deepEqual(seen, [
      "GET /proxy",
      "GET /pool",
      "POST /sync",
      "GET /proxy",
    ]);
  }, 60_000);
}

test("proxy logs print the registration and the requests of the Mac as JSON lines", async () => {
  const { f, key } = await enabled();
  const first = requestId(await policyRefused(f, key));
  const printed = await f.run(["proxy", "logs"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stderr, "");
  const lines = rows(printed.stdout);
  assert.ok(lines.every((line) => line.vm === "mac"));
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["policy", "request"],
  );
  assert.deepEqual(lines[0]?.changes, { registered: true });
  assert.equal(lines[1]?.id, first);
  assert.equal(lines[1].outcome, "denied");
  assert.ok(!printed.stdout.includes(key));
  const everything = await f.run(["proxy", "logs", "--all"]);
  assert.equal(everything.stdout, printed.stdout);
}, 60_000);

test("proxy logs --follow prints a request that arrives while it waits", async () => {
  const { f, key } = await enabled();
  const first = requestId(await policyRefused(f, key));
  const context = { gateway: () => f.control } as unknown as Context;
  const emitted: string[] = [];
  let second = "";
  let tick = 0;
  await assert.rejects(
    proxyCommand(["logs", "--follow"], context, {
      emit: (line) => emitted.push(line),
      pause: async () => {
        tick++;
        if (tick > 1) {
          throw new Error("stop");
        }
        second = requestId(await policyRefused(f, key));
      },
    }),
    /stop/u,
  );
  const ids = rows(emitted.join("\n"))
    .filter((line) => line.kind === "request")
    .map((line) => line.id);
  assert.deepEqual(ids, [first, second]);
}, 60_000);

test("disable removes the file, disables the instance and stops the listener", async () => {
  const { f, key } = await enabled();
  const mac = f.control.state.byName("mac");
  assert.equal(await listens(f.port), true);
  const result = await f.run(["proxy", "disable"]);
  assert.deepEqual(result, {
    status: 0,
    stdout: "the proxy is disabled, and its key no longer works\n",
    stderr: "",
  });
  assert.equal(existsSync(f.where.proxy), false);
  assert.equal(existsSync(f.where.proxyCa), false);
  assert.equal(f.control.state.byName("mac"), null);
  assert.equal(f.control.state.byId(mac?.id ?? "")?.disabled, true);
  assert.equal(await listens(f.port), false);
  assert.ok(!result.stdout.includes(key));
  const status = await f.run(["proxy", "status"]);
  assert.deepEqual(status, { status: 0, stdout: "off\n", stderr: "" });
  const again = await f.run(["proxy", "disable"]);
  assert.deepEqual(again, {
    status: 1,
    stdout: "",
    stderr: "cog: the proxy is not enabled\n",
  });
  const printed = await f.run(["proxy", "logs"]);
  assert.equal(printed.status, 1);
  assert.equal(printed.stdout, "");
  assert.match(printed.stderr, /^cog: the proxy is not enabled; /u);
}, 60_000);

test("enable after disable makes a new key and a new instance", async () => {
  const { f, key } = await enabled();
  const old = f.control.state.byName("mac");
  assert.equal((await f.run(["proxy", "disable"])).status, 0);
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 0, result.stderr);
  const renewed = keyOf(f);
  assert.notEqual(renewed, key);
  const mac = f.control.state.byName("mac");
  assert.notEqual(mac, null);
  assert.notEqual(mac?.id, old?.id);
  assert.equal(await listens(f.port), true);
  const stale = await connectThrough(f.port, "example.com:443", key);
  assert.match(stale.head, /^HTTP\/1\.1 407 /u);
  const fresh = await connectThrough(f.port, "example.com:443", renewed);
  assert.match(fresh.head, /^HTTP\/1\.1 200 /u);
}, 60_000);

for (const pool of ["unconfigured", "unusable"] as const) {
  test(`enable with a ${pool} pool fails and leaves no file and no instance`, async () => {
    const f = await fixture(pool);
    await f.daemon();
    const result = await f.run(["proxy", "enable"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^cog: the Claude pool has no usable account; see cog account status[^\n]*\n$/u,
    );
    refused(f);
    assert.equal(await listens(f.port), false);
  }, 60_000);
}

test("enable fails with the gateway's reason when another listener holds the port", async () => {
  const f = await fixture();
  await f.daemon();
  const holder = net.createServer();
  await new Promise<void>((resolve) => {
    holder.listen({ host: "::1", port: f.port, ipv6Only: true }, resolve);
  });
  onTestFinished(() => {
    holder.close();
  });
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(
      String.raw`^cog: the gateway cannot serve the proxy: cannot listen on \[::1\]:${String(f.port)} \(EADDRINUSE\); see [^\n]*\n$`,
      "u",
    ),
  );
  noUrl(result.stderr);
  refused(f);
}, 60_000);

test("enable with a gateway that answers 404 to /proxy writes nothing and says to run ./install.sh", async () => {
  const f = await fixture();
  const seen = await f.stub(() => [404, {}]);
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^cog: cannot ask the gateway about the proxy: the running gateway is older than this cog; run \.\/install\.sh in the cog checkout\n$/u,
  );
  assert.deepEqual(seen, ["GET /proxy"]);
  refused(f);
}, 60_000);

test("enable with no gateway running writes nothing and registers nothing", async () => {
  const f = await fixture();
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^cog: cannot ask the gateway about the proxy: [^\n]+\n$/u,
  );
  refused(f);
}, 60_000);

test("enable whose sync fails after the registration removes the file and the registration", async () => {
  const f = await fixture();
  const seen = await f.stub((url) => {
    if (url === "/proxy") {
      return [200, { state: "off", reason: null }];
    }
    if (url === "/pool") {
      return [200, { state: "usable", reason: null, accounts: [] }];
    }
    return [500, {}];
  });
  const result = await f.run(["proxy", "enable"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^cog: the gateway did not take the Mac's registration: gateway administration failed; see [^\n]*\n$/u,
  );
  assert.deepEqual(seen, ["GET /proxy", "GET /pool", "POST /sync"]);
  noUrl(result.stderr);
  refused(f);
}, 60_000);

const leftovers = {
  "a URL file with no instance": async (f: Fixture) => {
    writeFileSync(f.where.proxy, `${proxyUrl(leftoverKey, f.port)}\n`, {
      mode: 0o600,
    });
    await f.daemon();
    return "the Mac is not registered";
  },
  "an instance with no URL file": async (f: Fixture) => {
    await f.daemon();
    await f.control.register("mac");
    return "the proxy URL file is missing";
  },
};

for (const [name, leave] of Object.entries(leftovers)) {
  test(`status reports ${name} as unusable`, async () => {
    const f = await fixture();
    const reason = await leave(f);
    const result = await f.run(["proxy", "status"]);
    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: `cog: the proxy is unusable: ${reason}\n`,
    });
    assert.equal(await listens(f.port), false);
  }, 60_000);

  test(`enable repairs ${name}`, async () => {
    const f = await fixture();
    await leave(f);
    const result = await f.run(["proxy", "enable"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(leftoverKey));
    const key = keyOf(f);
    assert.notEqual(key, leftoverKey);
    assert.notEqual(f.control.state.byName("mac"), null);
    assert.equal(statSync(f.where.proxy).mode & 0o777, 0o600);
    const tunnel = await connectThrough(f.port, "api.anthropic.com:443", key);
    assert.match(tunnel.head, /^HTTP\/1\.1 200 /u);
    const status = await f.run(["proxy", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^listening on /u);
  }, 60_000);

  test(`disable removes ${name}`, async () => {
    const f = await fixture();
    await leave(f);
    const result = await f.run(["proxy", "disable"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.where.proxy), false);
    assert.equal(f.control.state.byName("mac"), null);
    const status = await f.run(["proxy", "status"]);
    assert.deepEqual(status, { status: 0, stdout: "off\n", stderr: "" });
  }, 60_000);
}

test("proxy usage errors name the command and exit 1 before the gateway is asked", async () => {
  const f = await fixture();
  for (const args of [
    ["proxy"],
    ["proxy", "frob"],
    ["proxy", "enable", "x"],
    ["proxy", "disable", "x"],
    ["proxy", "status", "--all"],
    ["proxy", "logs", "--bad"],
    ["proxy", "logs", "--all", "--follow"],
    ["proxy", "logs", "x", "y"],
  ]) {
    const result = await f.run(args);
    assert.deepEqual(
      result,
      { status: 1, stdout: "", stderr: `cog: ${usage}\n` },
      args.join(" "),
    );
  }
  assert.equal(existsSync(f.where.proxy), false);
}, 60_000);

test("proxy logs without an enabled proxy says so", async () => {
  const f = await fixture();
  const result = await f.run(["proxy", "logs"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^cog: the proxy is not enabled; /u);
});

test("help lists the proxy verbs and names the URL file under COG_ROOT", async () => {
  const f = await fixture();
  const result = await f.run(["help"]);
  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.includes(
      "cog proxy enable|disable|status|logs [--follow|--all]",
    ),
    result.stdout,
  );
  assert.ok(
    result.stdout.includes(path.join(f.root, "secrets", "proxy-url")),
    result.stdout,
  );
});

test("cog logs reaches the Mac by its name, and the VM commands cannot change it", async () => {
  const { f, key } = await enabled();
  await policyRefused(f, key);
  const mac = f.control.state.byName("mac");
  const logs = await f.run(["logs", "mac"]);
  const proxied = await f.run(["proxy", "logs"]);
  assert.equal(logs.status, 0, logs.stderr);
  assert.equal(logs.stdout, proxied.stdout);
  for (const args of [
    ["disable", "mac"],
    ["show", "mac"],
  ]) {
    const result = await f.run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.ok(!result.stderr.includes(key));
    assert.deepEqual(f.control.state.byName("mac"), mac, args.join(" "));
    assert.deepEqual(f.control.state.grants(mac?.id ?? ""), {});
  }
  assert.equal(await listens(f.port), true);
}, 60_000);

for (const value of ["0", "65536", "abc", "17443x", "-1", " 1", "1e3"]) {
  test(`COG_PROXY_PORT=${JSON.stringify(value)} is refused by name`, async () => {
    const f = await fixture();
    const result = await f.run(["proxy", "status"], { COG_PROXY_PORT: value });
    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: "cog: COG_PROXY_PORT is not a port number\n",
    });
  });
}

test("status fails when the gateway answers listening and the database has no Mac", async () => {
  const f = await fixture();
  await f.stub(() => [200, { state: "listening", reason: null }]);
  mkdirSync(f.where.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(f.where.secrets, "ca.pem"), "a certificate\n");
  writeFileSync(f.where.proxyCa, "a certificate\n");
  assert.deepEqual(await f.run(["proxy", "status"]), {
    status: 1,
    stdout: "",
    stderr: "cog: the proxy is unusable: the Mac is not registered\n",
  });
});

test("COG_PROXY_PORT that is empty means the default port, and 1 and 65535 are ports", async () => {
  const f = await fixture();
  await f.stub(() => [200, { state: "listening", reason: null }]);
  const mac = f.control.state.register(
    "mac",
    path.join(f.where.sockets, "github-aa-11.sock"),
    "tester",
  );
  mkdirSync(f.where.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(f.where.secrets, "ca.pem"), "a certificate\n");
  writeFileSync(f.where.proxyCa, "a certificate\n");
  for (const [value, port] of [
    ["", proxyPort],
    ["1", 1],
    ["65535", 65_535],
  ] as const) {
    const result = await f.run(["proxy", "status"], { COG_PROXY_PORT: value });
    assert.deepEqual(result, {
      status: 0,
      stdout: `listening on [::1]:${String(port)} as ${mac.id}\n`,
      stderr: "",
    });
  }
});
