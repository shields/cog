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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http, {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { once, type EventEmitter } from "node:events";
import https from "node:https";
import {
  connect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  mock,
  type Mock,
  onTestFinished,
  spyOn,
  test,
} from "bun:test";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { AppAuth } from "./auth.ts";
import { compareCodeUnits } from "./policy.ts";
import { Gateway } from "./server.ts";
import { State, type Instance } from "./state.ts";

afterEach(() => {
  mock.restore();
});

const createHttpsServer = https.createServer;
const createHttpServer = http.createServer;

const idRef = (id: string): string => `refs/heads/cog/${id}/one`;
const pages = (repository: string): string =>
  `<https://api.github.com/${repository}/pulls?page=2>; rel="next", <https://api.github.com/${repository}/pulls?page=3>; rel="last"`;

function packet(line: string): Buffer {
  const body = Buffer.from(line);
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}

function send(
  socket: string,
  method: string,
  target: string,
  body: Buffer | Buffer[] = Buffer.alloc(0),
  host = "github.com",
  headers: Record<string, string> = {},
  agent: https.Agent | false = false,
): Promise<{
  status: number;
  type: string | undefined;
  body: string;
  headers: IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        socketPath: socket,
        servername: host,
        rejectUnauthorized: false,
        method,
        path: target,
        agent,
        headers: {
          host,
          ...(Array.isArray(body) ? {} : { "content-length": body.length }),
          authorization: "Bearer guest-token",
          cookie: "session=guest",
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"],
            body: Buffer.concat(chunks).toString(),
            headers: response.headers,
          });
        });
      },
    );
    request.once("error", reject);
    if (Array.isArray(body)) {
      const [first = Buffer.alloc(0), ...rest] = body;
      request.write(first);
      // The pause makes the gateway read the first chunk on its own.
      setTimeout(() => {
        for (const chunk of rest) {
          request.write(chunk);
        }
        request.end();
      }, 20);
    } else {
      request.end(body);
    }
  });
}

interface Forwarded {
  target: string;
  authorization: string | undefined;
  cookie: string | undefined;
  contentEncoding: string | undefined;
  transferEncoding: string | undefined;
  body: Buffer;
}

const tokens = {
  alpha: "sk-ant-oat01-made-up-alpha-token",
  bravo: "sk-ant-oat01-made-up-bravo-token",
} as const;
const accountToken = tokens.alpha;

type PoolSpec = Record<string, string> | "missing" | "unset";

const throwaway = mkdtempSync(path.join(tmpdir(), "cog-cert-"));
const certificate = path.join(throwaway, "cert.pem");
const key = path.join(throwaway, "key.pem");

beforeAll(() => {
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=github.com",
      "-addext",
      "subjectAltName=DNS:github.com",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
});

afterAll(() => {
  rmSync(throwaway, { recursive: true, force: true });
});

// Undo functions run last-in-first-out. A gateway's stop() waits for open
// client connections, which only undo functions registered after it can close.
let teardown: AsyncDisposableStack | undefined;

function defer(undo: () => void | Promise<void>): void {
  if (!teardown) {
    const created = new AsyncDisposableStack();
    teardown = created;
    onTestFinished(() => {
      teardown = undefined;
      return created.disposeAsync();
    });
  }
  teardown.defer(undo);
}

function rawUpstream(connection: (socket: Socket) => void): Server & {
  closeAllConnections: () => void;
} {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    connection(socket);
  });
  return Object.assign(server, {
    closeAllConnections: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  });
}

function writePool(directory: string, accounts: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  for (const [name, token] of Object.entries(accounts)) {
    const file = path.join(directory, name);
    writeFileSync(file, `${token}\n`);
    chmodSync(file, 0o600);
  }
}

async function startGateway(
  upstreamOptions: {
    handler?: RequestListener;
    tls?: boolean;
    connection?: (socket: Socket) => void;
    githubOrigins?: boolean;
    models?: {
      pool?: PoolSpec;
      anthropic?: string;
      fireworks?: string;
      fireworksKeyFile?: string;
    };
  } | null = null,
): Promise<{
  root: string;
  poolDirectory: string;
  origin: string;
  socket: string;
  instance: Instance;
  state: State;
  auth: AppAuth;
  gateway: Gateway;
  incoming: Forwarded[];
  listener: https.Server;
  created: Mock<typeof https.createServer>;
  closed: () => Promise<void>;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "cog-server-"));
  defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const state = new State(path.join(root, "state"));
  defer(() => {
    if (state.db.isOpen) {
      state.close();
    }
  });
  const secretDirectory = path.join(root, "secrets");
  mkdirSync(secretDirectory);
  const auth = new AppAuth(secretDirectory);
  const incoming: Forwarded[] = [];
  const record: RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      incoming.push({
        target: request.url ?? "",
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        contentEncoding: request.headers["content-encoding"],
        transferEncoding: request.headers["transfer-encoding"],
        body: Buffer.concat(chunks),
      });
      response
        .writeHead(request.url?.includes("/shields/private") ? 404 : 200, {
          link: pages("repositories/1296269"),
        })
        .end("ok");
    });
  };
  const serve = upstreamOptions?.handler ?? record;
  const upstream = upstreamOptions?.connection
    ? rawUpstream(upstreamOptions.connection)
    : upstreamOptions?.tls
      ? https.createServer(
          { cert: readFileSync(certificate), key: readFileSync(key) },
          serve,
        )
      : createServer(serve);
  const agentOptions = https.globalAgent.options;
  const trusted = agentOptions.ca;
  defer(() => {
    agentOptions.ca = trusted;
  });
  defer(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => {
      upstream.close(() => {
        resolve();
      });
    });
  });
  if (upstreamOptions?.tls) {
    agentOptions.ca = readFileSync(certificate);
  }
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const socket = path.join(root, "work.sock");
  const instance = state.register("lima:work", socket, "tester");
  state.update(
    "lima:work",
    0,
    { "shields/dotfiles": { read: true, pushCogBranches: true } },
    "tester",
  );
  writeFileSync(
    path.join(
      secretDirectory,
      `${Buffer.from("shields/dotfiles").toString("base64url")}.json`,
    ),
    JSON.stringify({
      client_id: "Iv-test",
      repository: "shields/dotfiles",
      access_token: "ghu_secret",
      access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "ghr_secret",
      refresh_expires_at: Math.floor(Date.now() / 1000) + 86_400,
      web_url: "https://github.com",
      api_url: "https://api.github.com",
    }),
  );
  const origin = `${upstreamOptions?.tls ? "https" : "http"}://127.0.0.1:${String(address.port)}`;
  const poolDirectory = path.join(root, "claude-pool");
  const models = upstreamOptions?.models;
  const poolSpec = models?.pool ?? { alpha: accountToken };
  if (models && typeof poolSpec === "object") {
    writePool(poolDirectory, poolSpec);
  }
  const gateway = new Gateway(state, auth, {
    cert: certificate,
    key,
    adminSocket: path.join(root, "admin.sock"),
    webUpstream: upstreamOptions?.githubOrigins ? "https://github.com" : origin,
    apiUpstream: upstreamOptions?.githubOrigins
      ? "https://api.github.com"
      : origin,
    ...(models && poolSpec !== "unset" ? { pool: poolDirectory } : {}),
    ...(models?.anthropic === undefined
      ? {}
      : { anthropicUpstream: models.anthropic }),
    ...(models?.fireworks === undefined
      ? {}
      : { fireworksUpstream: models.fireworks }),
    ...(models?.fireworksKeyFile === undefined
      ? {}
      : { fireworksKeyFile: models.fireworksKeyFile }),
  });
  const created = spyOn(https, "createServer");
  const earlier = created.mock.results.length;
  defer(() => gateway.stop());
  await gateway.start();
  const result = created.mock.results[earlier];
  assert.equal(result?.type, "return");
  const listener = result.value;
  const responses: Promise<void>[] = [];
  listener.on("request", (_request, response) => {
    responses.push(
      new Promise((resolve) => {
        response.once("close", resolve);
      }),
    );
  });
  const closed = async (): Promise<void> => {
    await Promise.all(responses);
  };
  return {
    root,
    poolDirectory,
    origin,
    socket,
    instance,
    state,
    auth,
    gateway,
    incoming,
    listener,
    created,
    closed,
  };
}

test("the HTTPS socket injects a repo token only after checking the full push and live grant", async () => {
  const { socket, instance, state, incoming, listener } = await startGateway();
  assert.equal(listener.requestTimeout, 3_600_000);
  assert.equal(listener.headersTimeout, 60_000);
  assert.equal(
    (
      await send(
        socket,
        "GET",
        "/__cog__/health",
        Buffer.alloc(0),
        "api.github.com",
      )
    ).status,
    200,
  );
  assert.equal(incoming.length, 0);
  const fetched = await send(
    socket,
    "GET",
    "/shields/dotfiles.git/info/refs?service=git-upload-pack",
  );
  assert.equal(fetched.status, 200);
  assert.equal(
    incoming[0]?.authorization,
    `Basic ${Buffer.from("x-access-token:ghu_secret").toString("base64")}`,
  );
  const good = Buffer.concat([
    packet(
      `${"0".repeat(40)} ${"1".repeat(40)} ${idRef(instance.id)}\0report-status\n`,
    ),
    Buffer.from("0000PACK"),
  ]);
  assert.equal(
    (await send(socket, "POST", "/shields/dotfiles.git/git-receive-pack", good))
      .status,
    200,
  );
  assert.deepEqual(incoming[1]?.body, good);
  const identity = await send(
    socket,
    "GET",
    "/user",
    Buffer.alloc(0),
    "api.github.com",
  );
  assert.equal(identity.status, 200);
  assert.equal(identity.headers.link, pages("repositories/1296269"));
  assert.equal(incoming[2]?.authorization, "Bearer ghu_secret");
  const discovery = Buffer.from(
    JSON.stringify({
      query:
        '{ viewer { login } repo_000: repository(owner: "shields", name: "dotfiles") { name } }',
      variables: null,
    }),
  );
  assert.equal(
    (await send(socket, "POST", "/graphql", discovery, "api.github.com"))
      .status,
    200,
  );
  assert.equal(incoming[3]?.authorization, "Bearer ghu_secret");
  assert.deepEqual(incoming[3].body, discovery);
  const bad = Buffer.concat([
    packet(
      `${"0".repeat(40)} ${"1".repeat(40)} ${idRef(instance.id)}\0report-status\n`,
    ),
    packet(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/main\n`),
    Buffer.from("0000PACK"),
    Buffer.alloc(4_194_304),
  ]);
  const reported = await send(
    socket,
    "POST",
    "/shields/dotfiles.git/git-receive-pack",
    bad,
  );
  assert.deepEqual(
    { status: reported.status, type: reported.type, body: reported.body },
    {
      status: 200,
      type: "application/x-git-receive-pack-result",
      body: Buffer.concat([
        packet("unpack ok\n"),
        packet(
          `ng ${idRef(instance.id)} another ref update in this push is denied\n`,
        ),
        packet(
          `ng refs/heads/main push destination is outside this VM's cog namespace; allowed namespace: cog/${instance.id}/*\n`,
        ),
        Buffer.from("0000"),
      ]).toString(),
    },
  );
  const unreported = await send(
    socket,
    "POST",
    "/shields/dotfiles.git/git-receive-pack",
    Buffer.concat([
      packet(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/main\0quiet`),
      Buffer.from("0000PACK"),
    ]),
  );
  assert.equal(unreported.status, 403);
  assert.equal(unreported.type, "text/plain; charset=utf-8");
  assert.equal(
    unreported.body.split("\n", 1)[0],
    `push destination is outside this VM's cog namespace; allowed namespace: cog/${instance.id}/*`,
  );
  assert.match(unreported.body, /^[^\n]+\nrequest ID: [0-9a-f-]{36}\n$/);
  assert.equal(incoming.length, 4);
  for (const log of state.logs(instance.id).slice(0, 2)) {
    assert.equal(log.allowed, false);
    assert.equal(
      log.reason,
      `push destination is outside this VM's cog namespace; allowed namespace: cog/${instance.id}/*`,
    );
    assert.equal(log.outcome, "denied");
  }
  const probe = Buffer.from("0000");
  assert.equal(
    (
      await send(
        socket,
        "POST",
        "/shields/dotfiles.git/git-receive-pack",
        probe,
      )
    ).status,
    200,
  );
  assert.equal(
    incoming[4]?.authorization,
    `Basic ${Buffer.from("x-access-token:ghu_secret").toString("base64")}`,
  );
  assert.deepEqual(incoming[4].body, probe);
  const large = Buffer.concat([good, Buffer.alloc(2 * 1_048_576, 1)]);
  assert.equal(
    (
      await send(socket, "POST", "/shields/dotfiles.git/git-receive-pack", [
        large.subarray(0, 20),
        large.subarray(20),
      ])
    ).status,
    200,
  );
  assert.equal(incoming[5]?.transferEncoding, "chunked");
  assert.equal(incoming[5].authorization, incoming[4].authorization);
  assert.equal(incoming[5].body.length, large.length);
  assert.ok(incoming[5].body.equals(large));
  const shallow = Buffer.concat([packet(`shallow ${"2".repeat(40)}\n`), good]);
  assert.equal(
    (
      await send(socket, "POST", "/shields/dotfiles.git/git-receive-pack", [
        shallow.subarray(0, 20),
        shallow.subarray(20),
      ])
    ).status,
    200,
  );
  assert.equal(incoming[6]?.authorization, incoming[4].authorization);
  assert.deepEqual(incoming[6].body, shallow);
  assert.equal(
    (
      await send(
        socket,
        "POST",
        "/shields/dotfiles.git/git-receive-pack",
        Buffer.from("0000PACK"),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await send(socket, "POST", "/shields/dotfiles.git/git-receive-pack", [
        probe,
        good,
      ])
    ).status,
    403,
  );
  assert.equal(incoming.length, 7);
  const listed = await send(
    socket,
    "GET",
    "/repos/Shields/Dotfiles/pulls",
    Buffer.alloc(0),
    "api.github.com",
  );
  assert.equal(listed.headers.link, pages("repos/shields/dotfiles"));
  const next = /<https:\/\/api\.github\.com([^>]+)>; rel="next"/.exec(
    listed.headers.link,
  )?.[1];
  assert.equal(next, "/repos/shields/dotfiles/pulls?page=2");
  assert.equal(
    (await send(socket, "GET", next, Buffer.alloc(0), "api.github.com")).status,
    200,
  );
  assert.equal(incoming[8]?.target, next);
  assert.equal(incoming[8].authorization, "Bearer ghu_secret");
  state.update("lima:work", 1, {}, "tester");
  assert.equal(
    (await send(socket, "POST", "/graphql", discovery, "api.github.com"))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        socket,
        "GET",
        "/shields/dotfiles.git/info/refs?service=git-upload-pack",
      )
    ).status,
    200,
  );
  assert.equal(incoming.length, 10);
  assert.equal(incoming[9]?.authorization, undefined);
  const logs = state.logs(instance.id);
  assert.equal(logs.length, 16);
  assert.equal(logs[0]?.revision, 2);
  assert.equal(logs[0].allowed, true);
  assert.equal(logs[0].reason, "anonymous read");

  for (const repository of [
    "shields/dotfiles",
    "octocat/Hello-World",
    "shields/private",
  ]) {
    for (const [host, method, target, body] of [
      [
        "github.com",
        "GET",
        `/${repository}.git/info/refs?service=git-upload-pack`,
        Buffer.alloc(0),
      ],
      [
        "github.com",
        "POST",
        `/${repository}.git/git-upload-pack`,
        Buffer.from("0000"),
      ],
      [
        "github.com",
        "GET",
        `/${repository}/info/refs?service=git-upload-pack`,
        Buffer.alloc(0),
      ],
      [
        "github.com",
        "POST",
        `/${repository}/git-upload-pack`,
        Buffer.from("0000"),
      ],
      ["api.github.com", "GET", `/repos/${repository}/pulls`, Buffer.alloc(0)],
      ["api.github.com", "HEAD", `/repos/${repository}`, Buffer.alloc(0)],
      ["github.com", "GET", `/${repository}`, Buffer.alloc(0)],
      [
        "github.com",
        "HEAD",
        `/${repository}/archive/refs/heads/main.zip`,
        Buffer.alloc(0),
      ],
    ] as const) {
      const response = await send(socket, method, target, body, host);
      assert.equal(
        response.status,
        repository === "shields/private" ? 404 : 200,
        target,
      );
      assert.equal(incoming.at(-1)?.authorization, undefined, target);
      assert.equal(incoming.at(-1)?.cookie, undefined, target);
      assert.deepEqual(incoming.at(-1)?.body, body, target);
      assert.equal(
        response.headers.link,
        pages(
          host === "api.github.com"
            ? `repos/${repository.toLowerCase()}`
            : "repositories/1296269",
        ),
        target,
      );
    }
  }
  const forwarded = incoming.length;
  for (const [host, method, target, body] of [
    [
      "github.com",
      "GET",
      "/shields/dotfiles.git/info/refs?service=git-receive-pack",
      Buffer.alloc(0),
    ],
    ["github.com", "POST", "/shields/dotfiles.git/git-receive-pack", good],
    ["github.com", "POST", "/shields/dotfiles.git/git-receive-pack", probe],
    [
      "api.github.com",
      "POST",
      "/repos/shields/dotfiles/issues",
      Buffer.from("{}"),
    ],
    ["api.github.com", "POST", "/graphql", discovery],
    ["api.github.com", "GET", "/user", Buffer.alloc(0)],
  ] as const) {
    const denied = await send(socket, method, target, body, host);
    assert.equal(denied.status, 403, target);
    if (host === "github.com") {
      assert.equal(denied.type, "text/plain; charset=utf-8", target);
      assert.match(denied.body, /^repository is not granted to this VM\n/);
    } else {
      assert.equal(denied.type, "application/json", target);
      assert.equal(
        (JSON.parse(denied.body) as { message: unknown }).message,
        target === "/repos/shields/dotfiles/issues"
          ? "unsupported GitHub API operation"
          : "repository is not granted to this VM",
        target,
      );
    }
  }
  state.disable("lima:work", "tester");
  assert.equal((await send(socket, "GET", "/shields/dotfiles")).status, 403);
  assert.equal(incoming.length, forwarded);
});

test("the gateway inspects a body whenever the policy would route the request, however the target is spelled", async () => {
  const { socket, instance, incoming } = await startGateway();
  const repository = "/shields/dotfiles.git";
  const pushBody = (ref: string, capabilities: string): Buffer =>
    Buffer.concat([
      packet(`${"0".repeat(40)} ${"1".repeat(40)} ${ref}\0${capabilities}\n`),
      Buffer.from("0000PACK"),
    ]);
  const queryBody = (name: string): Buffer =>
    Buffer.from(
      JSON.stringify({
        query: `{ repo_000: repository(owner: "shields", name: "${name}") { name } }`,
        variables: null,
      }),
    );
  const good = pushBody(idRef(instance.id), "report-status");
  const bad = pushBody("refs/heads/main", "quiet");
  const goodQuery = queryBody("dotfiles");
  const badQuery = queryBody("other");
  for (const [host, target, allowedBody, deniedBody] of [
    ["github.com", `${repository}/git-receive-pack?`, good, bad],
    ["github.com", `${repository}/git-receive-pack#x`, good, bad],
    ["github.com", "/shields/dotfiles.git\\git-receive-pack", good, bad],
    ["api.github.com", "/graphql?", goodQuery, badQuery],
    ["api.github.com", "/graphql#x", goodQuery, badQuery],
    ["api.github.com", "/x/../graphql", goodQuery, badQuery],
    ["api.github.com", "/%2e/graphql", goodQuery, badQuery],
  ] as const) {
    const before = incoming.length;
    const refused = await send(socket, "POST", target, deniedBody, host);
    assert.equal(refused.status, 403, target);
    assert.equal(incoming.length, before, target);
    const accepted = await send(socket, "POST", target, allowedBody, host);
    assert.equal(accepted.status, 200, target);
    assert.equal(incoming.length, before + 1, target);
    assert.equal(
      incoming[before]?.target,
      host === "github.com" ? `${repository}/git-receive-pack` : "/graphql",
      target,
    );
    assert.deepEqual(incoming[before].body, allowedBody, target);
  }
});

test("a POST with a query string that the policy refuses is denied without its body being read", async () => {
  const { socket, instance, incoming, state } = await startGateway();
  for (const [host, target, body, headers, reason] of [
    [
      "github.com",
      "/shields/dotfiles.git/git-receive-pack?x=1",
      Buffer.concat([
        packet(
          `${"0".repeat(40)} ${"1".repeat(40)} refs/heads/main\0report-status\n`,
        ),
        Buffer.from("0000PACK"),
      ]),
      {},
      "unsupported GitHub Git operation",
    ],
    [
      "api.github.com",
      "/graphql?x=1",
      Buffer.from("{}"),
      { "content-encoding": "gzip" },
      "unsupported GitHub API operation",
    ],
  ] as const) {
    const refused = await send(socket, "POST", target, body, host, headers);
    assert.equal(refused.status, 403, target);
    assert.equal(state.logs(instance.id)[0]?.reason, reason, target);
  }
  assert.equal(incoming.length, 0);
});

test("a GraphQL body past the inspection limit is denied while it is being read", async () => {
  const { socket, instance, incoming, state } = await startGateway();
  const refused = await send(
    socket,
    "POST",
    "/graphql",
    Buffer.alloc(1_048_577),
    "api.github.com",
  );
  assert.equal(refused.status, 403);
  assert.equal(
    state.logs(instance.id)[0]?.reason,
    "request prefix is too large",
  );
  assert.equal(incoming.length, 0);
});

test("a push to a cog branch name that Git would refuse is denied before anything reaches the upstream", async () => {
  const { socket, instance, incoming, state } = await startGateway();
  const reply = await send(
    socket,
    "POST",
    "/shields/dotfiles.git/git-receive-pack",
    Buffer.concat([
      packet(
        `${"0".repeat(40)} ${"1".repeat(40)} refs/heads/cog/${instance.id}/../../main\0report-status\n`,
      ),
      Buffer.from("0000PACK"),
    ]),
  );
  assert.equal(reply.status, 403);
  assert.match(reply.body, /push destination is not a valid Git ref name/);
  assert.equal(incoming.length, 0);
  assert.equal(state.logs(instance.id)[0]?.allowed, false);
  assert.equal(
    state.logs(instance.id)[0]?.reason,
    "push destination is not a valid Git ref name",
  );
});

test("Content-Encoding reaches GitHub only on fetch bodies, and inspected bodies must be unencoded", async () => {
  const { socket, instance, incoming } = await startGateway();
  const negotiation = gzipSync(
    Buffer.concat([packet(`want ${"1".repeat(40)}\n`), Buffer.from("0000")]),
  );
  assert.equal(
    (
      await send(
        socket,
        "POST",
        "/shields/dotfiles.git/git-upload-pack",
        negotiation,
        "github.com",
        { "content-encoding": "gzip" },
      )
    ).status,
    200,
  );
  assert.equal(incoming.at(-1)?.contentEncoding, "gzip");
  assert.deepEqual(incoming.at(-1)?.body, negotiation);
  assert.equal(
    (
      await send(
        socket,
        "GET",
        "/shields/dotfiles.git/info/refs?service=git-upload-pack",
        Buffer.alloc(0),
        "github.com",
        { "content-encoding": "gzip" },
      )
    ).status,
    200,
  );
  assert.equal(incoming.at(-1)?.contentEncoding, undefined);

  const push = Buffer.concat([
    packet(
      `${"0".repeat(40)} ${"1".repeat(40)} ${idRef(instance.id)}\0report-status\n`,
    ),
    Buffer.from("0000PACK"),
  ]);
  const query = Buffer.from(
    JSON.stringify({
      query: '{ repository(owner: "shields", name: "dotfiles") { name } }',
    }),
  );
  const forwarded = incoming.length;
  for (const [host, target, body, encoding] of [
    ["github.com", "/shields/dotfiles.git/git-receive-pack", push, "gzip"],
    [
      "github.com",
      "/shields/dotfiles.git/git-receive-pack",
      gzipSync(push),
      "gzip",
    ],
    ["github.com", "/shields/dotfiles.git/git-receive-pack", push, ""],
    ["api.github.com", "/graphql", query, "br"],
    ["api.github.com", "/graphql", query, "identity, gzip"],
  ] as const) {
    const response = await send(socket, "POST", target, body, host, {
      "content-encoding": encoding,
    });
    assert.equal(response.status, 403, `${target} ${encoding}`);
    assert.match(
      response.body,
      host === "github.com"
        ? /^encoded request bodies are unsupported\n/
        : /"message":"encoded request bodies are unsupported"/,
    );
  }
  assert.equal(incoming.length, forwarded);

  for (const [host, target, body, encoding] of [
    ["github.com", "/shields/dotfiles.git/git-receive-pack", push, "identity"],
    ["api.github.com", "/graphql", query, "Identity"],
  ] as const) {
    assert.equal(
      (
        await send(socket, "POST", target, body, host, {
          "content-encoding": encoding,
        })
      ).status,
      200,
      target,
    );
    assert.equal(incoming.at(-1)?.contentEncoding, undefined, target);
    assert.deepEqual(incoming.at(-1)?.body, body, target);
  }
});

async function exchange(
  socket: string,
  host: string,
  request: string,
): Promise<string> {
  const client = tlsConnect({
    path: socket,
    servername: host,
    rejectUnauthorized: false,
  });
  defer(() => {
    client.destroy();
  });
  const chunks: Buffer[] = [];
  client.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  client.write(request);
  await within("the gateway to close the connection", once(client, "close"));
  return Buffer.concat(chunks).toString();
}

function smugglingUpstream(): {
  received: Buffer[];
  connection: (socket: Socket) => void;
} {
  const received: Buffer[] = [];
  return {
    received,
    connection: (socket) => {
      let replied = false;
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        if (replied || !Buffer.concat(received).includes("\r\n\r\n")) {
          return;
        }
        replied = true;
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      });
    },
  };
}

function rawRequest(
  method: string,
  target: string,
  host: string,
  headers = "",
  payload = "",
): string {
  const lines = [`host: ${host}`, "connection: close", headers].filter(Boolean);
  return `${method} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${payload}`;
}

const hiddenRequest = "GET /user HTTP/1.1\r\nhost: api.github.com\r\n\r\n";
const chunkedBody = `${hiddenRequest.length.toString(16)}\r\n${hiddenRequest}\r\n0\r\n\r\n`;

test("a GET or HEAD with a chunked body is denied and none of it reaches the upstream", async () => {
  const { received, connection } = smugglingUpstream();
  const { socket, instance, state } = await startGateway({ connection });
  const requests = [
    ["api.github.com", "GET", "/repos/shields/dotfiles/pulls"],
    ["api.github.com", "HEAD", "/repos/shields/dotfiles"],
    [
      "github.com",
      "GET",
      "/shields/dotfiles.git/info/refs?service=git-upload-pack",
    ],
  ] as const;
  for (const [host, method, target] of requests) {
    const reply = await exchange(
      socket,
      host,
      rawRequest(
        method,
        target,
        host,
        "transfer-encoding: chunked",
        chunkedBody,
      ),
    );
    assert.equal(Buffer.concat(received).toString(), "", `${method} ${target}`);
    assert.match(reply, /^HTTP\/1\.1 403 /, `${method} ${target}`);
  }
  assert.deepEqual(
    state
      .logs(instance.id)
      .map(({ allowed, reason, outcome }) => ({ allowed, reason, outcome })),
    requests.map(() => ({
      allowed: false,
      reason: "GET and HEAD requests must not have a body",
      outcome: "denied",
    })),
  );
  assert.deepEqual(
    state
      .logs(instance.id)
      .map(({ operation, repository }) => `${operation} ${String(repository)}`)
      .toSorted((a, b) => a.localeCompare(b)),
    [
      "api.read shields/dotfiles",
      "api.read shields/dotfiles",
      "git.read shields/dotfiles",
    ],
  );
});

test("ambiguous request framing never reaches the upstream, and a GET with an empty body does", async () => {
  const { received, connection } = smugglingUpstream();
  const { socket, instance, state } = await startGateway({ connection });
  const outcomes: [string, string, string, number][] = [
    // The HTTP parser or the gateway rejects these; either way nothing
    // reaches the upstream.
    [
      "GET",
      "transfer-encoding: chunked\r\ncontent-length: 5",
      chunkedBody,
      400,
    ],
    [
      "GET",
      "content-length: 5\r\ntransfer-encoding: chunked",
      chunkedBody,
      400,
    ],
    [
      "POST",
      "transfer-encoding: chunked\r\ncontent-length: 5",
      chunkedBody,
      400,
    ],
    ["GET", "transfer-encoding: chunked, identity", chunkedBody, 400],
    [
      "GET",
      "transfer-encoding: chunked\r\ntransfer-encoding: chunked",
      chunkedBody,
      400,
    ],
    ["GET", "transfer-encoding : chunked", chunkedBody, 400],
    ["GET", "transfer-encoding: chunked\r\n\tfolded", chunkedBody, 400],
    ["GET", "content-length: 5\r\ncontent-length: 6", "abcde", 400],
    ["GET", "content-length: +5", "abcde", 400],
    ["GET", "content-length: 5", "abcde", 403],
    ["GET", "content-length: 1", "a", 403],
    ["GET", "transfer-encoding: gzip, chunked", chunkedBody, 403],
    ["GET", "transfer-encoding: gzip", chunkedBody, 403],
    ["GET", "transfer-encoding: identity", "", 403],
    ["GET", "transfer-encoding:", "", 403],
    ["GET", "transfer-encoding:\tchunked", chunkedBody, 403],
    ["GET", "content-length: 0", "", 200],
  ];
  for (const [method, headers, payload, status] of outcomes) {
    received.length = 0;
    const reply = await exchange(
      socket,
      "api.github.com",
      rawRequest(
        method,
        "/repos/shields/dotfiles/pulls",
        "api.github.com",
        headers,
        payload,
      ),
    );
    const label = `${method} ${JSON.stringify(headers)}`;
    const replied = Number(reply.split(" ", 2)[1]);
    assert.ok(
      status === 400 ? replied === 400 || replied === 403 : replied === status,
      `${label}: ${String(replied)}`,
    );
    const request = Buffer.concat(received).toString();
    if (status === 200) {
      assert.equal(request.split("\r\n\r\n").at(-1), "", label);
      assert.doesNotMatch(request, /GET \/user/, label);
    } else {
      assert.equal(request, "", label);
    }
  }
  const denied = state.logs(instance.id).filter(({ allowed }) => !allowed);
  const must = outcomes.filter((outcome) => outcome[3] === 403).length;
  const may = outcomes.filter((outcome) => outcome[3] === 400).length;
  assert.ok(
    denied.length >= must && denied.length <= must + may,
    `${String(denied.length)} denials`,
  );
});

test("a request target that names an authority is denied and sends no credentials upstream", async () => {
  const { socket, instance, state, incoming, origin } = await startGateway({
    githubOrigins: true,
  });
  const local = new URL(origin);
  const reached: string[] = [];
  const redirect = (url: URL, options: https.RequestOptions): ClientRequest => {
    reached.push(url.href);
    const redirected = new URL(url);
    redirected.protocol = local.protocol;
    redirected.host = local.host;
    return httpRequest(redirected, options);
  };
  spyOn(https, "request").mockImplementation(redirect as typeof https.request);
  const targets = [
    [
      "github.com",
      "//attacker:ghp_token@github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
    ],
    [
      "github.com",
      "//attacker:ghp_token@github.com/shields/dotfiles.git/info/refs?service=git-upload-pack",
    ],
    [
      "api.github.com",
      "//attacker:ghp_token@api.github.com/repos/octocat/Hello-World/pulls",
    ],
    ["github.com", "//github.com/octocat/Hello-World"],
    [
      "github.com",
      String.raw`/\attacker:ghp_token@github.com/octocat/Hello-World`,
    ],
  ] as const;
  for (const [host, target] of targets) {
    const reply = await exchange(
      socket,
      host,
      rawRequest("GET", target, host, "accept: */*", ""),
    );
    assert.equal(Number(reply.split(" ", 2)[1]), 403, `${host} ${target}`);
  }
  assert.equal(reached.length, 0);
  assert.equal(incoming.length, 0);
  const logs = state.logs(instance.id);
  assert.equal(logs.length, targets.length);
  for (const log of logs) {
    assert.equal(log.allowed, false);
    assert.equal(log.reason, "request target must stay on its GitHub host");
    assert.equal(log.outcome, "denied");
  }
  const control = await exchange(
    socket,
    "github.com",
    rawRequest(
      "GET",
      "/octocat/Hello-World.git/info/refs?service=git-upload-pack",
      "github.com",
      "accept: */*",
      "",
    ),
  );
  assert.equal(Number(control.split(" ", 2)[1]), 200);
  assert.deepEqual(reached, [
    "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
  ]);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]?.authorization, undefined);
});

test("a state failure as a request starts is a 503 with an audit row and does not crash the gateway", async () => {
  const { socket, instance, state } = await startGateway();
  const stderr = captureStderr();
  spyOn(state, "byId").mockImplementationOnce((): never => {
    throw new Error("database is locked");
  });
  const { response } = open(socket);
  const reply = await within("the gateway to answer", response);
  assert.equal(reply.status, 503);
  await nextTurn();
  const requestId = requestIdIn(reply.body);
  assert.deepEqual(
    state.logs(instance.id).map(({ id, allowed, reason, outcome }) => ({
      id,
      allowed,
      reason,
      outcome,
    })),
    [
      {
        id: requestId,
        allowed: false,
        reason: "gateway request failed",
        outcome: "denied",
      },
    ],
  );
  assert.deepEqual(stderr, [
    failureLine(requestId, instance, "Error: database is locked"),
  ]);
});

test("a failure that is not a policy denial is reported on stderr, audited and answered with a 503", async () => {
  const { socket, instance, state, auth } = await startGateway();
  const stderr = captureStderr();
  const denied = await send(
    socket,
    "POST",
    "/graphql?x=1",
    Buffer.from("{}"),
    "api.github.com",
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(stderr, []);
  spyOn(auth, "token").mockRejectedValueOnce(
    new Error("GitHub refused refresh for shields/dotfiles"),
  );
  const failed = await send(
    socket,
    "GET",
    "/shields/dotfiles.git/info/refs?service=git-upload-pack",
  );
  assert.equal(failed.status, 503);
  assert.match(failed.body, /gateway request failed/);
  assert.deepEqual(stderr, [
    failureLine(
      requestIdIn(failed.body),
      instance,
      "Error: GitHub refused refresh for shields/dotfiles",
    ),
  ]);
  assert.deepEqual(
    state
      .logs(instance.id)
      .map(({ reason, outcome }) => ({ reason, outcome }))
      .toSorted((a, b) => a.reason.localeCompare(b.reason)),
    [
      { reason: "gateway request failed", outcome: "denied" },
      { reason: "unsupported GitHub API operation", outcome: "denied" },
    ],
  );
});

test("an upstream that failed on every address is reported with each of its failures", async () => {
  const { socket, instance, auth } = await startGateway();
  const stderr = captureStderr();
  spyOn(auth, "token").mockRejectedValueOnce(
    new AggregateError(
      [
        new Error("connect ECONNREFUSED ::1:443"),
        new Error("connect ECONNREFUSED 127.0.0.1:443"),
      ],
      "all attempts failed",
    ),
  );
  const failed = await send(
    socket,
    "GET",
    "/shields/dotfiles.git/info/refs?service=git-upload-pack",
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(stderr, [
    failureLine(
      requestIdIn(failed.body),
      instance,
      "AggregateError: all attempts failed: Error: connect ECONNREFUSED ::1:443; Error: connect ECONNREFUSED 127.0.0.1:443",
    ),
  ]);
});

test("a state failure that also stops the audit write is reported on stderr and answered with a 503", async () => {
  const { socket, instance, state } = await startGateway();
  const stderr = captureStderr();
  const failure = (): never => {
    throw new Error("database is locked");
  };
  spyOn(state, "byId").mockImplementation(failure);
  spyOn(state, "logDecision").mockImplementation(failure);
  const { response } = open(socket);
  const reply = await within("the gateway to answer", response);
  await nextTurn();
  assert.equal(reply.status, 503);
  assert.match(reply.body, /gateway audit unavailable/);
  assert.deepEqual(stderr, [
    failureLine(requestIdIn(reply.body), instance, "Error: database is locked"),
    "cog audit failure: Error: database is locked\n",
  ]);
});

test("the health path is answered locally however the target spells it", async () => {
  const { socket, state, incoming } = await startGateway();
  const audit = recordFinishes(state, 3);
  for (const target of [
    "/__cog__/health",
    "/x/../__cog__/health",
    "/__cog__/./health",
  ]) {
    const response = await send(
      socket,
      "GET",
      target,
      Buffer.alloc(0),
      "api.github.com",
    );
    assert.equal(response.status, 200, target);
    assert.equal(response.body, "cog ready\n", target);
  }
  await within("the audit rows", audit.all);
  assert.deepEqual(
    audit.calls,
    Array.from({ length: 3 }, () => ({ status: 200, outcome: "completed" })),
  );
  assert.equal(incoming.length, 0);
  const page = await send(socket, "GET", "/shields/dotfiles");
  assert.equal(page.body, "ok");
  assert.equal(incoming.length, 1);
});

function signal(): { promise: Promise<undefined>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    promise,
    resolve: () => {
      resolve(undefined);
    },
  };
}

async function within<T>(what: string, pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not happen within 5 s`));
    }, 5000);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const requestShapes: Record<
  "get" | "post" | "upload" | "push" | "deniedPush",
  { method: string; path: string; body?: string; ends: boolean }
> = {
  get: {
    method: "GET",
    path: "/shields/dotfiles.git/info/refs?service=git-upload-pack",
    ends: true,
  },
  post: {
    method: "POST",
    path: "/shields/dotfiles.git/git-upload-pack",
    body: "0000",
    ends: true,
  },
  upload: {
    method: "POST",
    path: "/shields/dotfiles.git/git-upload-pack",
    body: "0000",
    ends: false,
  },
  push: {
    method: "POST",
    path: "/shields/dotfiles.git/git-receive-pack",
    body: "00",
    ends: false,
  },
  deniedPush: {
    method: "POST",
    path: "/shields/dotfiles.git/git-receive-pack",
    body: `${packet(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/main\0report-status\n`).toString()}0000`,
    ends: false,
  },
};

function open(
  socket: string,
  mode: keyof typeof requestShapes = "get",
  agent: https.Agent | false = false,
): {
  request: ClientRequest;
  firstData: Promise<void>;
  response: Promise<{ status: number; body: string; complete: boolean }>;
} {
  const { method, path, body, ends } = requestShapes[mode];
  const request = https.request({
    socketPath: socket,
    servername: "github.com",
    rejectUnauthorized: false,
    method,
    path,
    agent,
    headers: { host: "github.com" },
  });
  defer(() => {
    request.destroy();
  });
  const firstData = signal();
  const response = new Promise<{
    status: number;
    body: string;
    complete: boolean;
  }>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        firstData.resolve();
      });
      incoming.once("close", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          complete: incoming.complete,
        });
      });
    });
  });
  if (ends) {
    request.end(body);
  } else {
    request.write(body ?? "");
  }
  return { request, firstData: firstData.promise, response };
}

function recordFinishes(
  state: State,
  expected = 1,
): {
  calls: { status: number | null; outcome: string }[];
  first: Promise<void>;
  all: Promise<void>;
} {
  const calls: { status: number | null; outcome: string }[] = [];
  const first = signal();
  const all = signal();
  const finish = state.finish.bind(state);
  spyOn(state, "finish").mockImplementation(
    (
      id: string,
      status: number | null,
      durationMs: number,
      outcome: string,
    ): void => {
      finish(id, status, durationMs, outcome);
      calls.push({ status, outcome });
      first.resolve();
      if (calls.length === expected) {
        all.resolve();
      }
    },
  );
  return { calls, first: first.promise, all: all.promise };
}

function captureStderr(): string[] {
  const writes: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

function requestIdIn(body: string): string {
  const id = /^request ID: ([0-9a-f-]{36})$/m.exec(body)?.[1];
  assert.ok(id, body);
  return id;
}

function failureLine(
  requestId: string,
  instance: Instance,
  cause: string,
): string {
  return `cog: gateway request failed (request ${requestId}, VM ${instance.id}): ${cause}\n`;
}

function failureLinePattern(
  state: State,
  instance: Instance,
  cause: string,
): RegExp {
  const [row, ...others] = state.logs(instance.id);
  assert.ok(row);
  assert.deepEqual(others, []);
  return new RegExp(
    String.raw`^cog: gateway request failed \(request ${row.id}, VM ${instance.id}\): ${cause}\n$`,
  );
}

function auditRows(
  state: State,
  instance: Instance,
): { outcome: string; upstreamStatus: number | null }[] {
  return state
    .logs(instance.id)
    .map(({ outcome, upstreamStatus }) => ({ outcome, upstreamStatus }));
}

const endings = {
  fin: (socket: Socket) => {
    socket.end();
  },
  destroy: (socket: Socket) => {
    socket.destroy();
  },
  reset: (socket: Socket) => {
    socket.resetAndDestroy();
  },
};

const endsEarly: {
  name: string;
  tls: boolean;
  begin: RequestListener;
  end: keyof typeof endings;
}[] = [
  {
    name: "FIN after a chunk, without the final chunk",
    tls: false,
    begin: (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    },
    end: "fin",
  },
  {
    name: "FIN in the middle of a chunk",
    tls: false,
    begin: (request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.flushHeaders();
      request.socket.write("64\r\npart");
    },
    end: "fin",
  },
  {
    name: "FIN before the end of a Content-Length body",
    tls: false,
    begin: (_request, response) => {
      response.writeHead(200, { "content-length": 100_000 });
      response.write("partial");
    },
    end: "fin",
  },
  {
    name: "TLS close_notify without the final chunk",
    tls: true,
    begin: (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    },
    end: "fin",
  },
  {
    name: "TLS EOF without close_notify",
    tls: true,
    begin: (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    },
    end: "destroy",
  },
  {
    name: "TCP reset",
    tls: false,
    begin: (_request, response) => {
      response.writeHead(200, { "content-length": 100_000 });
      response.write("partial");
    },
    end: "reset",
  },
];

for (const { name, tls, begin, end } of endsEarly) {
  test(`an upstream that ends its body early (${name}) fails the client's response and is audited as a gateway error`, async () => {
    const clientHasData = signal();
    const { socket, instance, state, closed } = await startGateway({
      handler: (request, response) => {
        begin(request, response);
        void clientHasData.promise.then(() => {
          endings[end](request.socket);
        });
      },
      tls,
    });
    const stderr = captureStderr();
    const audit = recordFinishes(state);
    const { firstData, response } = open(socket);
    void firstData.then(clientHasData.resolve);
    const fetched = await within("the client's response to close", response);
    await within("the audit row", audit.first);
    await within("the gateway's response to close", closed());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.complete, false);
    assert.deepEqual(auditRows(state, instance), [
      { outcome: "gateway-error", upstreamStatus: null },
    ]);
    assert.deepEqual(audit.calls, [{ status: null, outcome: "gateway-error" }]);
    assert.match(stderr.join(""), failureLinePattern(state, instance, ".+"));
  });
}

for (const { name, respond } of [
  {
    name: "Content-Length body",
    respond: ((_request, response) => {
      response.writeHead(200, { "content-length": 7 }).end("partial");
    }) satisfies RequestListener,
  },
  {
    name: "chunked body",
    respond: ((_request, response) => {
      response.writeHead(200);
      response.write("par");
      response.end("tial");
    }) satisfies RequestListener,
  },
  {
    name: "body that ends when the upstream closes the connection",
    respond: ((request) => {
      request.socket.end("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\npartial");
    }) satisfies RequestListener,
  },
]) {
  test(`a complete response (${name}) is audited once, as completed`, async () => {
    const { socket, instance, state, closed } = await startGateway({
      handler: respond,
      tls: false,
    });
    const audit = recordFinishes(state);
    const { response } = open(socket);
    const fetched = await within("the client's response to close", response);
    await within("the audit row", audit.first);
    await within("the gateway's response to close", closed());
    assert.deepEqual(fetched, { status: 200, body: "partial", complete: true });
    assert.deepEqual(auditRows(state, instance), [
      { outcome: "completed", upstreamStatus: 200 },
    ]);
    assert.deepEqual(audit.calls, [{ status: 200, outcome: "completed" }]);
  });
}

for (const [name, respond] of [
  [
    "hangs up",
    (request) => {
      request.socket.destroy();
    },
  ],
  [
    "resets the connection",
    (request) => {
      request.socket.resetAndDestroy();
    },
  ],
] as [string, RequestListener][]) {
  test(`an upstream that ${name} before sending headers is a gateway error with a 503`, async () => {
    const { socket, instance, state, closed } = await startGateway({
      handler: respond,
      tls: false,
    });
    const stderr = captureStderr();
    const audit = recordFinishes(state);
    const { response } = open(socket);
    const fetched = await within("the client's response to close", response);
    await within("the audit row", audit.first);
    await within("the gateway's response to close", closed());
    assert.equal(fetched.status, 503);
    assert.equal(fetched.complete, true);
    assert.deepEqual(auditRows(state, instance), [
      { outcome: "gateway-error", upstreamStatus: null },
    ]);
    assert.deepEqual(audit.calls, [{ status: null, outcome: "gateway-error" }]);
    assert.match(stderr.join(""), failureLinePattern(state, instance, ".+"));
  });
}

test("an upstream status that cannot be relayed is a gateway error with a 503 and a closed upstream connection, and the gateway keeps serving", async () => {
  let answers = 0;
  const upstreamClosed = signal();
  const { socket, instance, state, closed } = await startGateway({
    handler: (request, response) => {
      answers += 1;
      if (answers === 1) {
        request.socket.once("close", upstreamClosed.resolve);
        request.socket.write(
          "HTTP/1.1 099 Weird\r\ncontent-length: 100000\r\n\r\npartial",
        );
      } else {
        response.writeHead(200, { "content-length": 2 }).end("ok");
      }
    },
    tls: false,
  });
  const stderr = captureStderr();
  const audit = recordFinishes(state);
  const target = "/shields/dotfiles.git/info/refs?service=git-upload-pack";
  const broken = await within("the response", send(socket, "GET", target));
  await within("the audit row", audit.first);
  await within("the upstream connection to close", upstreamClosed.promise);
  assert.equal(broken.status, 503);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "gateway-error" }]);
  assert.match(
    stderr.join(""),
    failureLinePattern(state, instance, String.raw`.*\b99\b.*`),
  );
  const next = await within("the response", send(socket, "GET", target));
  await within("the gateway's responses to close", closed());
  assert.equal(next.status, 200);
  assert.equal(next.body, "ok");
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "completed", upstreamStatus: 200 },
    { outcome: "gateway-error", upstreamStatus: null },
  ]);
});

test("a Content-Length response that names a Trailer header is delivered without it", async () => {
  const { socket, instance, state, closed } = await startGateway({
    handler: (request) => {
      request.socket.end(
        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\ntrailer: x-checksum\r\nconnection: close\r\n\r\nok",
      );
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const fetched = await within(
    "the response",
    send(
      socket,
      "GET",
      "/shields/dotfiles.git/info/refs?service=git-upload-pack",
    ),
  );
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body, "ok");
  assert.equal(fetched.headers.trailer, undefined);
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "completed", upstreamStatus: 200 },
  ]);
});

test("a response that writeHead rejects after storing a header is answered with a well-formed 503", async () => {
  const { socket, instance, state, listener, closed } = await startGateway({
    handler: (_request, response) => {
      response.writeHead(200, { "content-length": 2 }).end("ok");
    },
    tls: false,
  });
  captureStderr();
  listener.on("request", (_request, reply) => {
    spyOn(reply, "writeHead").mockImplementationOnce(() => {
      reply.setHeader("content-length", "2");
      throw new Error("a header that writeHead rejects");
    });
  });
  const audit = recordFinishes(state);
  const broken = await within(
    "the response",
    send(
      socket,
      "GET",
      "/shields/dotfiles.git/info/refs?service=git-upload-pack",
    ),
  );
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  assert.equal(broken.status, 503);
  assert.match(broken.body, /gateway request failed/);
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "gateway-error", upstreamStatus: null },
  ]);
});

test("a request that fails after its headers were sent ends the connection, so the requests pipelined around it are not answered", async () => {
  const clientGone = signal();
  const allArrived = signal();
  const relayed = signal();
  let arrivals = 0;
  const { socket, instance, state, listener, closed } = await startGateway({
    handler: (request, response) => {
      arrivals += 1;
      if (arrivals === 3) {
        allArrived.resolve();
      }
      if (request.headers["user-agent"] === "fails") {
        response.writeHead(200, { "content-length": 100_000 });
        response.write("partial");
        void Promise.all([allArrived.promise, relayed.promise]).then(() => {
          request.socket.destroy();
        });
      } else {
        // The timeout bounds the wait when the gateway leaves the connection
        // open.
        void Promise.race([clientGone.promise, delay(1000)]).then(() => {
          response.writeHead(200, { "content-length": 2 }).end("ok");
        });
      }
    },
    tls: false,
  });
  listener.on("request", (request, reply) => {
    if (request.headers["user-agent"] === "fails") {
      reply.once("pipe", relayed.resolve);
    }
  });
  captureStderr();
  const audit = recordFinishes(state, 3);
  const get = (agent: string): string =>
    `GET /shields/dotfiles.git/info/refs?service=git-upload-pack HTTP/1.1\r\nhost: github.com\r\nuser-agent: ${agent}\r\n\r\n`;
  const received = await exchange(
    socket,
    "github.com",
    get("before") + get("fails") + get("after"),
  );
  clientGone.resolve();
  await within("the gateway's responses to close", closed());
  await within("the audit rows", audit.all);
  assert.equal(arrivals, 3);
  assert.equal(received, "");
  assert.deepEqual(
    auditRows(state, instance)
      .map(({ outcome }) => outcome)
      .toSorted((a, b) => a.localeCompare(b)),
    ["gateway-error", "interrupted", "interrupted"],
  );
});

test("a client that leaves mid-body is audited as interrupted and the upstream request is aborted", async () => {
  const upstreamClosed = signal();
  const { socket, instance, state, closed } = await startGateway({
    handler: (request, response) => {
      request.socket.once("close", upstreamClosed.resolve);
      response.writeHead(200, { "content-length": 100_000 });
      response.write("partial");
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const { request, firstData } = open(socket);
  await within("the first byte of the body", firstData);
  request.destroy();
  await within("the audit row", audit.first);
  await within("the upstream connection to close", upstreamClosed.promise);
  await within("the gateway's response to close", closed());
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "interrupted", upstreamStatus: 200 },
  ]);
  assert.deepEqual(audit.calls, [{ status: 200, outcome: "interrupted" }]);
});

test("a client that leaves before the upstream answers is audited as interrupted and the upstream request is aborted", async () => {
  const asked = signal();
  const upstreamClosed = signal();
  const { socket, instance, state, closed } = await startGateway({
    handler: (request) => {
      asked.resolve();
      request.socket.once("close", upstreamClosed.resolve);
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const { request, response } = open(socket);
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the upstream to receive the request", asked.promise);
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the audit row", audit.first);
  await within("the upstream connection to close", upstreamClosed.promise);
  await within("the gateway's response to close", closed());
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "interrupted", upstreamStatus: null },
  ]);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
});

for (const [name, mode] of [
  ["a GET", "get"],
  ["a POST that arrived whole", "post"],
] as const) {
  test(`a client that leaves while its token is being fetched (${name}) is audited as interrupted and never reaches the upstream`, async () => {
    const { socket, instance, state, auth, incoming, closed } =
      await startGateway();
    const audit = recordFinishes(state);
    const asked = signal();
    const resume = signal();
    defer(resume.resolve);
    spyOn(auth, "token").mockImplementation(async (): Promise<string> => {
      asked.resolve();
      await resume.promise;
      return "ghu_secret";
    });
    const { request, response } = open(socket, mode);
    const hungUp = assert.rejects(response, { message: "socket hang up" });
    await within("the gateway to ask for a token", asked.promise);
    request.destroy();
    await within("the client's request to fail", hungUp);
    await within("the gateway's response to close", closed());
    resume.resolve();
    await within("the audit row", audit.first);
    assert.deepEqual(auditRows(state, instance), [
      { outcome: "interrupted", upstreamStatus: null },
    ]);
    assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
    assert.deepEqual(incoming, []);
  });
}

for (const [name, mode] of [
  ["a GET", "get"],
  ["a POST that arrived whole", "post"],
] as const) {
  test(`a client whose socket is destroyed as its token arrives (${name}) is not forwarded over a warm upstream connection`, async () => {
    const { socket, instance, state, auth, listener, incoming, closed } =
      await startGateway();
    const target = "/shields/dotfiles.git/info/refs?service=git-upload-pack";
    const warm = await send(socket, "GET", target);
    assert.equal(warm.status, 200);
    const audit = recordFinishes(state);
    let serverSide: Socket | undefined;
    listener.prependOnceListener("request", (request) => {
      serverSide = request.socket;
    });
    spyOn(auth, "token").mockImplementation((): Promise<string> => {
      serverSide?.destroy();
      return Promise.resolve("ghu_secret");
    });
    const { request, response } = open(socket, mode);
    const hungUp = assert.rejects(response, { message: "socket hang up" });
    await within("the client's request to fail", hungUp);
    await within("the audit row", audit.first);
    await within("the gateway's response to close", closed());
    request.destroy();
    const sentinel = await send(socket, "GET", target);
    assert.equal(sentinel.status, 200);
    assert.deepEqual(
      auditRows(state, instance).filter(
        ({ outcome }) => outcome === "interrupted",
      ),
      [{ outcome: "interrupted", upstreamStatus: null }],
    );
    assert.deepEqual(audit.calls, [
      { status: null, outcome: "interrupted" },
      { status: 200, outcome: "completed" },
    ]);
    assert.deepEqual(
      incoming.map(({ target: sent }) => sent),
      [target, target],
    );
  });
}

test("a client whose socket is destroyed as the answer is relayed to it is audited as interrupted", async () => {
  const { socket, instance, state, listener, closed } = await startGateway();
  const audit = recordFinishes(state);
  listener.prependOnceListener("request", (request, reply) => {
    reply.once("pipe", () => {
      request.socket.destroy();
    });
  });
  const { response } = open(socket);
  assert.equal(
    (await within("the client's response to end", response)).complete,
    false,
  );
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "interrupted", upstreamStatus: 200 },
  ]);
  assert.deepEqual(audit.calls, [{ status: 200, outcome: "interrupted" }]);
});

test("a client that leaves while uploading is audited as interrupted and the upstream request is aborted", async () => {
  const asked = signal();
  const upstreamClosed = signal();
  const { socket, instance, state, closed } = await startGateway({
    handler: (request) => {
      request.resume();
      asked.resolve();
      request.socket.once("close", upstreamClosed.resolve);
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const { request, response } = open(socket, "upload");
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the upstream to receive the request", asked.promise);
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the audit row", audit.first);
  await within("the upstream connection to close", upstreamClosed.promise);
  await within("the gateway's response to close", closed());
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "interrupted", upstreamStatus: null },
  ]);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
});

test("a client that leaves while its push commands are being read is audited as interrupted, not denied", async () => {
  const { socket, instance, state, listener, incoming, closed } =
    await startGateway();
  const stderr = captureStderr();
  const audit = recordFinishes(state);
  const requested = signal();
  listener.on("request", requested.resolve);
  const { request, response } = open(socket, "push");
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the gateway to receive the request", requested.promise);
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  assert.deepEqual(
    state.logs(instance.id).map(({ allowed, operation, reason, outcome }) => ({
      allowed,
      operation,
      reason,
      outcome,
    })),
    [
      {
        allowed: false,
        operation: "unknown",
        reason: "request aborted",
        outcome: "interrupted",
      },
    ],
  );
  assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
  assert.deepEqual(incoming, []);
  assert.deepEqual(stderr, []);
});

test("a client that leaves while the rest of a denied push is being read does not crash the gateway", async () => {
  const { socket, instance, state, closed } = await startGateway();
  const audit = recordFinishes(state);
  const { request, response } = open(socket, "deniedPush");
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the audit row", audit.first);
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the gateway's response to close", closed());
  // Yield so an unhandled rejection from the gateway is reported while this
  // test is still running.
  await nextTurn();
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "denied", upstreamStatus: null },
  ]);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "denied" }]);
});

test("a failed listener refresh does not fail the refreshes queued behind it", async () => {
  const { gateway, state } = await startGateway();
  spyOn(state, "active").mockImplementationOnce((): never => {
    throw new Error("state unavailable");
  });
  const settled = await Promise.allSettled([
    gateway.refresh(),
    gateway.refresh(),
  ]);
  assert.deepEqual(
    settled.map(({ status }) => status),
    ["rejected", "fulfilled"],
  );
});

test("an upstream that answers before the upload ends has its request aborted when the client connection closes", async () => {
  const upstreamClosed = signal();
  const { socket, instance, state, closed } = await startGateway({
    handler: (request, response) => {
      request.socket.once("close", upstreamClosed.resolve);
      response.writeHead(200, { "content-length": 2 }).end("ok");
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const { response } = open(socket, "upload");
  const fetched = await within("the client's response to close", response);
  await within("the audit row", audit.first);
  await within("the upstream connection to close", upstreamClosed.promise);
  await within("the gateway's response to close", closed());
  assert.deepEqual(fetched, { status: 200, body: "ok", complete: true });
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "completed", upstreamStatus: 200 },
  ]);
  assert.deepEqual(audit.calls, [{ status: 200, outcome: "completed" }]);
});

test("an upstream that answers before the upload ends has its request aborted when a keep-alive client leaves", async () => {
  const upstreamClosed = signal();
  const { socket, instance, state, listener, closed } = await startGateway({
    handler: (request, response) => {
      request.socket.once("close", upstreamClosed.resolve);
      response.writeHead(403, { "content-length": 2 }).end("no");
    },
    tls: false,
  });
  let clientSide: Socket | undefined;
  listener.prependOnceListener("request", (request) => {
    clientSide = request.socket;
  });
  const audit = recordFinishes(state);
  const agent = new https.Agent({ keepAlive: true });
  defer(() => {
    agent.destroy();
  });
  const { request, response } = open(socket, "upload", agent);
  const fetched = await within("the client's response to close", response);
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  assert.equal(clientSide?.destroyed, false);
  request.destroy();
  await within("the upstream connection to close", upstreamClosed.promise);
  assert.deepEqual(fetched, { status: 403, body: "no", complete: true });
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "completed", upstreamStatus: 403 },
  ]);
  assert.deepEqual(audit.calls, [{ status: 403, outcome: "completed" }]);
});

test("an upstream that answers before the upload ends keeps receiving the rest of the upload", async () => {
  const uploaded = signal();
  let received = 0;
  const { socket, state, closed } = await startGateway({
    handler: (request, response) => {
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      request.once("end", uploaded.resolve);
      response.writeHead(200, { "content-length": 2 }).end("ok");
    },
    tls: false,
  });
  const audit = recordFinishes(state);
  const agent = new https.Agent({ keepAlive: true });
  defer(() => {
    agent.destroy();
  });
  const { request, response } = open(socket, "upload", agent);
  await within("the client's response to close", response);
  await within("the audit row", audit.first);
  await within("the gateway's response to close", closed());
  const rest = Buffer.alloc(8192, "a");
  request.end(rest);
  await within("the upstream to receive the whole upload", uploaded.promise);
  assert.equal(received, "0000".length + rest.length);
});

function watchCloseListeners(listener: https.Server): {
  connections: Set<Socket>;
  counts: number[];
} {
  const connections = new Set<Socket>();
  const counts: number[] = [];
  listener.on("request", (request) => {
    connections.add(request.socket);
    counts.push(request.socket.listenerCount("close"));
  });
  return { connections, counts };
}

test("GraphQL queries in sequence on one connection leave no listeners behind on its socket", async () => {
  const { socket, listener } = await startGateway();
  const watched = watchCloseListeners(listener);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  defer(() => {
    agent.destroy();
  });
  for (let round = 0; round < 8; round += 1) {
    const query = await send(
      socket,
      "POST",
      "/graphql",
      Buffer.from(
        JSON.stringify({
          query:
            '{ repo_000: repository(owner: "shields", name: "dotfiles") { name } }',
          variables: null,
        }),
      ),
      "api.github.com",
      {},
      agent,
    );
    assert.equal(query.status, 200);
  }
  assert.equal(watched.connections.size, 1);
  assert.equal(new Set(watched.counts).size, 1);
});

test("uploads in sequence on one connection leave no listeners behind on its socket", async () => {
  const uploads = Array.from({ length: 8 }, () => signal());
  let forwarded = 0;
  const { socket, listener } = await startGateway({
    handler: (request, response) => {
      uploads[forwarded]?.resolve();
      forwarded += 1;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-length": 2 }).end("ok");
      });
    },
    tls: false,
  });
  const watched = watchCloseListeners(listener);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  defer(() => {
    agent.destroy();
  });
  for (const upload of uploads) {
    const request = https.request({
      socketPath: socket,
      servername: "github.com",
      rejectUnauthorized: false,
      agent,
      method: "POST",
      path: "/shields/dotfiles.git/git-upload-pack",
      headers: { host: "github.com" },
    });
    const answered = new Promise<void>((resolve, reject) => {
      request.once("error", reject);
      request.once("response", (incoming) => {
        incoming.resume();
        incoming.once("end", resolve);
      });
    });
    request.write("0000");
    await within("the gateway to forward the upload", upload.promise);
    request.end("0000");
    await within("the response to end", answered);
  }
  assert.equal(watched.connections.size, 1);
  assert.equal(new Set(watched.counts).size, 1);
});

test("uploads that fail in sequence on one connection leave no listeners behind on its socket", async () => {
  const { socket, listener } = await startGateway({
    handler: (request) => {
      request.socket.destroy();
    },
    tls: false,
  });
  captureStderr();
  const watched = watchCloseListeners(listener);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  defer(() => {
    agent.destroy();
  });
  for (let round = 0; round < 8; round += 1) {
    const request = https.request({
      socketPath: socket,
      servername: "github.com",
      rejectUnauthorized: false,
      agent,
      method: "POST",
      path: "/shields/dotfiles.git/git-upload-pack",
      headers: { host: "github.com" },
    });
    const failed = signal();
    const answered = new Promise<number>((resolve, reject) => {
      request.once("error", reject);
      request.once("response", (incoming) => {
        failed.resolve();
        incoming.resume();
        incoming.once("end", () => {
          resolve(incoming.statusCode ?? 0);
        });
      });
    });
    request.write("0000");
    await within("the gateway to answer the failed upload", failed.promise);
    request.end("0000");
    assert.equal(await within("the response to end", answered), 503);
  }
  assert.equal(watched.connections.size, 1);
  assert.equal(new Set(watched.counts).size, 1, watched.counts.join(","));
});

function accepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = connect(socketPath);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => {
      resolve(false);
    });
  });
}

async function holdAuthorization(): Promise<
  Awaited<ReturnType<typeof startGateway>> & {
    events: string[];
    release: () => void;
  }
> {
  const started = await startGateway();
  const events: string[] = [];
  const asked = signal();
  const resume = signal();
  defer(resume.resolve);
  spyOn(started.auth, "token").mockImplementation(async (): Promise<string> => {
    asked.resolve();
    await resume.promise;
    events.push("token");
    return "ghu_secret";
  });
  const { request, response } = open(started.socket);
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the gateway to ask for a token", asked.promise);
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the gateway's response to close", started.closed());
  return { ...started, events, release: resume.resolve };
}

test("stop() waits for a request whose client left while it was authorizing, so its audit row is written before the database closes", async () => {
  const { gateway, state, instance, listener, events, release } =
    await holdAuthorization();
  const audit = recordFinishes(state);
  const decisions = spyOn(state, "logDecision");
  const shutdown = (async () => {
    await gateway.stop();
    events.push("stopped");
    const rows = auditRows(state, instance);
    state.close();
    return rows;
  })();
  await within("the listener to close", once(listener, "close"));
  // A stop() that does not wait for requests has resolved by now.
  await nextTurn();
  release();
  const rows = await within("the gateway to stop", shutdown);
  // Yield so a late write to the closed database is reported while this test
  // is still running.
  await nextTurn();
  assert.deepEqual(
    decisions.mock.results.map(({ type }) => type),
    ["return"],
  );
  assert.deepEqual(events, ["token", "stopped"]);
  assert.deepEqual(rows, [{ outcome: "interrupted", upstreamStatus: null }]);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
});

test("every one of several concurrent stop() calls waits for the in-flight requests", async () => {
  const { gateway, state, instance, listener, events, release } =
    await holdAuthorization();
  const shutdown = Promise.all(
    [0, 1, 2].map(async (call) => {
      await gateway.stop();
      events.push(`stopped ${String(call)}`);
      return auditRows(state, instance);
    }),
  );
  await within("the listener to close", once(listener, "close"));
  await nextTurn();
  release();
  const rows = await within("the gateway to stop", shutdown);
  assert.equal(events[0], "token");
  assert.deepEqual(
    events.slice(1).toSorted((a, b) => a.localeCompare(b)),
    ["stopped 0", "stopped 1", "stopped 2"],
  );
  assert.deepEqual(
    rows,
    Array.from({ length: 3 }, () => [
      { outcome: "interrupted", upstreamStatus: null },
    ]),
  );
});

for (const { name, scenario, events, finishes } of [
  {
    name: "a request that fails while stop() waits for it is still reported as an unhandled rejection, once",
    scenario: "interrupted",
    events: ["token", "stopped"],
    finishes: ["interrupted"],
  },
  {
    name: "a failed audit write for a relayed response is reported as an unhandled rejection, once, and is not retried as a gateway error",
    scenario: "completed",
    events: ["token", "stopped"],
    finishes: ["completed"],
  },
  {
    name: "a failed audit write for the health check is reported as an unhandled rejection, once, and is not retried as a gateway error",
    scenario: "health",
    events: ["stopped"],
    finishes: ["completed"],
  },
]) {
  test(
    name,
    () => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "stop-rejection.fixture.ts"),
          certificate,
          key,
          scenario,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        events,
        rejections: ["audit write failed"],
        finishes,
      });
    },
    60_000,
  );
}

function holdNextServer(created: Mock<typeof https.createServer>): {
  starting: Promise<undefined>;
  proceed: () => void;
} {
  const starting = signal();
  const proceed = signal();
  created.mockImplementationOnce(((
    ...args: Parameters<typeof https.createServer>
  ) => {
    const server = createHttpsServer(...args);
    const emit = server.emit.bind(server);
    server.emit = (event: string | symbol, ...rest: unknown[]) => {
      if (event !== "listening") {
        return emit(event, ...rest);
      }
      starting.resolve();
      void proceed.promise.then(() => emit(event, ...rest));
      return true;
    };
    return server;
  }) as typeof https.createServer);
  return { starting: starting.promise, proceed: proceed.resolve };
}

function requestSync(adminSocket: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sync = httpRequest(
      { socketPath: adminSocket, path: "/sync", method: "POST", agent: false },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    sync.once("error", reject);
    sync.end();
  });
}

interface Intervals {
  tick: (ms: number) => void;
}

function mockIntervals(): Intervals {
  const registered = new Map<object, { callback: () => void; delay: number }>();
  const clear = clearInterval;
  spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    const handle = {
      ref: () => handle,
      unref: () => handle,
      hasRef: () => true,
      refresh: () => handle,
    };
    registered.set(handle, { callback, delay });
    return handle;
  }) as unknown as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(((
    handle: Parameters<typeof clearInterval>[0],
  ) => {
    if (typeof handle !== "object" || !registered.delete(handle)) {
      clear(handle);
    }
  }) as typeof clearInterval);
  return {
    tick: (ms) => {
      for (const { callback, delay } of registered.values()) {
        for (let elapsed = delay; elapsed <= ms; elapsed += delay) {
          callback();
        }
      }
    },
  };
}

interface RefreshRace {
  name: string;
  servers: number;
  race: (context: {
    gateway: Gateway;
    state: State;
    created: Mock<typeof https.createServer>;
    adminSocket: string;
    intervals: Intervals;
  }) => Promise<void>;
}

for (const { name, servers, race } of [
  {
    name: "stop() begins after it read the active VMs",
    servers: 1,
    race: async ({ gateway, state }) => {
      const stops: Promise<void>[] = [];
      const active = state.active.bind(state);
      spyOn(state, "active").mockImplementationOnce((): Instance[] => {
        stops.push(gateway.stop());
        return active();
      });
      await gateway.refresh();
      await Promise.all(stops);
    },
  },
  {
    name: "stop() begins before it runs",
    servers: 1,
    race: async ({ gateway }) => {
      await Promise.all([gateway.refresh(), gateway.stop()]);
    },
  },
  {
    name: "stop() begins while its server is starting",
    servers: 2,
    race: async ({ gateway, created }) => {
      const held = holdNextServer(created);
      const refreshed = gateway.refresh();
      await within("the new server to start", held.starting);
      const stopped = gateway.stop();
      held.proceed();
      await Promise.all([refreshed, stopped]);
    },
  },
  {
    name: "stop() begins while the periodic refresh's server is starting",
    servers: 2,
    race: async ({ gateway, created, intervals }) => {
      const held = holdNextServer(created);
      intervals.tick(60_000);
      await within("the new server to start", held.starting);
      const stopped = gateway.stop();
      held.proceed();
      await stopped;
    },
  },
  {
    name: "stop() begins while a /sync request's server is starting",
    servers: 2,
    race: async ({ gateway, created, adminSocket }) => {
      const held = holdNextServer(created);
      const synced = requestSync(adminSocket);
      await within("the new server to start", held.starting);
      const stopped = gateway.stop();
      held.proceed();
      assert.equal(await within("the /sync response", synced), 200);
      await stopped;
    },
  },
] satisfies RefreshRace[]) {
  test(`a listener refresh in flight when ${name} leaves no listener behind`, async () => {
    const intervals = mockIntervals();
    const { socket, gateway, state, created } = await startGateway();
    defer(() => {
      for (const result of created.mock.results) {
        if (result.type === "return") {
          result.value.close();
        }
      }
    });
    const added = path.join(path.dirname(socket), "added.sock");
    const adminSocket = path.join(path.dirname(socket), "admin.sock");
    state.register("lima:added", added, "tester");
    await race({ gateway, state, created, adminSocket, intervals });
    await gateway.refresh();
    assert.equal(await accepting(added), false);
    assert.equal(created.mock.calls.length, servers);
    assert.deepEqual(
      created.mock.results.map((result) =>
        result.type === "return" ? result.value.listening : undefined,
      ),
      Array.from({ length: servers }, () => false),
    );
  });
}

function unstartedGateway(
  sockets: string[],
  adminSocket = "admin.sock",
): {
  root: string;
  gateway: Gateway;
  created: Mock<typeof https.createServer>;
} {
  const root = mkdtempSync(path.join(tmpdir(), "cog-server-"));
  const state = new State(path.join(root, "state"));
  const secrets = path.join(root, "secrets");
  mkdirSync(secrets);
  defer(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const [index, socket] of sockets.entries()) {
    state.register(
      `lima:vm${String(index)}`,
      path.join(root, socket),
      "tester",
    );
  }
  const gateway = new Gateway(state, new AppAuth(secrets), {
    cert: certificate,
    key,
    adminSocket: path.join(root, adminSocket),
  });
  const created = spyOn(https, "createServer");
  defer(() => gateway.stop());
  return { root, gateway, created };
}

for (const { name, listener, admin, starts } of [
  {
    name: "before start()",
    listener: "work.sock",
    admin: "admin.sock",
    starts: false,
  },
  {
    name: "after start() failed to open a VM listener",
    listener: "x/work.sock",
    admin: "admin.sock",
    starts: true,
  },
  {
    name: "after start() failed to open the admin socket",
    listener: "work.sock",
    admin: "x/admin.sock",
    starts: true,
  },
]) {
  test(`stop() ${name} and again afterwards does not throw, and the stopped gateway cannot start`, async () => {
    const { root, gateway } = unstartedGateway([listener], admin);
    if (starts) {
      await assert.rejects(gateway.start(), {
        code: "ENOENT",
        syscall: "listen",
      });
    }
    await gateway.stop();
    await gateway.stop();
    await assert.rejects(gateway.start(), { message: "gateway is stopped" });
    assert.equal(await accepting(path.join(root, listener)), false);
    assert.equal(await accepting(path.join(root, admin)), false);
  });
}

for (const { name, sockets, admin } of [
  {
    name: "a later VM listener cannot be opened",
    sockets: ["first.sock", "gone/second.sock"],
    admin: "admin.sock",
  },
  {
    name: "the admin socket cannot be opened",
    sockets: ["first.sock"],
    admin: "gone/admin.sock",
  },
]) {
  test(`start() fails with the original error and leaves nothing listening when ${name}`, async () => {
    const { root, gateway, created } = unstartedGateway(sockets, admin);
    await assert.rejects(gateway.start(), { syscall: "listen" });
    assert.equal(created.mock.calls.length, sockets.length);
    assert.equal(await accepting(path.join(root, "first.sock")), false);
    assert.equal(await accepting(path.join(root, admin)), false);
    assert.deepEqual(
      created.mock.results.map((result) =>
        result.type === "return" ? result.value.listening : undefined,
      ),
      sockets.map(() => false),
    );
  });
}

function interceptAdmin(intercept: (server: http.Server) => void): void {
  spyOn(http, "createServer").mockImplementation(((
    ...args: Parameters<typeof http.createServer>
  ) => {
    const server = createHttpServer(...args);
    intercept(server);
    return server;
  }) as typeof http.createServer);
}

interface StartRace {
  name: string;
  arm: (context: {
    gateway: Gateway;
    created: Mock<typeof https.createServer>;
    stops: Promise<void>[];
  }) => {
    race?: () => Promise<void>;
    onAdmin?: (server: http.Server) => void;
  };
}

const startRaces: StartRace[] = [
  {
    name: "start() is waiting for its first refresh",
    arm: ({ gateway, stops }) => ({
      race: () => {
        stops.push(gateway.stop());
        return Promise.resolve();
      },
    }),
  },
  {
    name: "a VM listener is opening",
    arm: ({ gateway, created, stops }) => {
      const held = holdNextServer(created);
      return {
        race: async () => {
          await within("the VM listener to open", held.starting);
          stops.push(gateway.stop());
          held.proceed();
        },
      };
    },
  },
  {
    name: "the admin server has just been asked to listen",
    arm: ({ gateway, stops }) => ({
      onAdmin: (server) => {
        const listen = server.listen.bind(server);
        server.listen = ((...args: Parameters<typeof server.listen>) => {
          const result = listen(...args);
          stops.push(gateway.stop());
          return result;
        }) as typeof server.listen;
      },
    }),
  },
  {
    name: "the admin server emits listening",
    arm: ({ gateway, stops }) => ({
      onAdmin: (server) => {
        const emit = server.emit.bind(server);
        server.emit = (event: string | symbol, ...rest: unknown[]) => {
          if (event === "listening") {
            stops.push(gateway.stop());
          }
          return emit(event, ...rest);
        };
      },
    }),
  },
];

for (const { name, arm } of startRaces) {
  test(`stop() while ${name} makes start() fail and leaves nothing listening or scheduled`, async () => {
    const intervals = mockIntervals();
    const { root, gateway, created } = unstartedGateway(["vm.sock"]);
    const refresh = spyOn(gateway, "refresh");
    const stops: Promise<void>[] = [];
    const { race, onAdmin } = arm({ gateway, created, stops });
    const admins: http.Server[] = [];
    interceptAdmin((server) => {
      admins.push(server);
      onAdmin?.(server);
    });
    const started = assert.rejects(gateway.start(), {
      message: "gateway is stopped",
    });
    await race?.();
    await within("start() to settle", started);
    assert.equal(stops.length, 1);
    await within("stop()", Promise.all(stops));
    assert.equal(admins.length, onAdmin ? 1 : 0);
    assert.equal(await accepting(path.join(root, "vm.sock")), false);
    assert.equal(await accepting(path.join(root, "admin.sock")), false);
    intervals.tick(60_000);
    await nextTurn();
    assert.equal(refresh.mock.calls.length, 1);
  });
}

test("a second start() fails without touching the gateway that is starting or started", async () => {
  const { root, gateway } = unstartedGateway(["vm.sock"]);
  const admins = spyOn(http, "createServer");
  const first = gateway.start();
  await assert.rejects(gateway.start(), {
    message: "gateway is already started",
  });
  await first;
  await assert.rejects(gateway.start(), {
    message: "gateway is already started",
  });
  assert.equal(admins.mock.calls.length, 1);
  assert.equal(await requestSync(path.join(root, "admin.sock")), 200);
});

function connectionCount(server: https.Server): Promise<number> {
  return promisify(server.getConnections.bind(server))();
}

function holdEvent(
  emitter: EventEmitter,
  name: string,
  until: Promise<unknown>,
  reached?: () => void,
): void {
  const emit = emitter.emit.bind(emitter);
  emitter.emit = (event: string | symbol, ...rest: unknown[]) => {
    if (event !== name) {
      return emit(event, ...rest);
    }
    reached?.();
    void until.then(() => emit(event, ...rest));
    return true;
  };
}

test("stop() waits for the server of a VM that was disabled, and for its idle keep-alive connections to end", async () => {
  const { socket, gateway, state, auth, listener } = await startGateway();
  listener.keepAliveTimeout = 600_000;
  const lingering = signal();
  defer(lingering.resolve);
  holdEvent(listener, "close", lingering.promise);
  const agent = new https.Agent({ keepAlive: true });
  defer(() => {
    agent.destroy();
  });
  const asked = signal();
  const resume = signal();
  defer(resume.resolve);
  spyOn(auth, "token").mockImplementation(async (): Promise<string> => {
    asked.resolve();
    await resume.promise;
    return "ghu_secret";
  });
  const { response } = open(socket, "get", agent);
  await within("the gateway to ask for a token", asked.promise);
  state.disable("lima:work", "tester");
  await gateway.refresh();
  assert.equal(listener.listening, false);
  assert.equal(await connectionCount(listener), 1);
  let closed = false;
  listener.once("close", () => {
    closed = true;
  });
  const stopping = gateway.stop();
  resume.resolve();
  assert.equal((await within("the response", response)).status, 403);
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await nextTurn();
  await nextTurn();
  assert.equal(stopped, false);
  lingering.resolve();
  await within("stop()", stopping);
  assert.equal(closed, true);
  assert.equal(await connectionCount(listener), 0);
});

test("stop() lets a transfer in flight finish and then ends its keep-alive connection without waiting for the keep-alive timeout", async () => {
  const finish = signal();
  const { socket, gateway, listener } = await startGateway({
    handler: (_request, response) => {
      response.writeHead(200, { "content-length": 2 });
      response.write("a");
      void finish.promise.then(() => response.end("b"));
    },
    tls: false,
  });
  listener.keepAliveTimeout = 600_000;
  defer(finish.resolve);
  const agent = new https.Agent({ keepAlive: true });
  defer(() => {
    agent.destroy();
  });
  const { firstData, response } = open(socket, "get", agent);
  await within("the first part of the response", firstData);
  let stopped = false;
  const stopping = (async () => {
    await gateway.stop();
    stopped = true;
  })();
  await nextTurn();
  await nextTurn();
  assert.equal(stopped, false);
  finish.resolve();
  assert.deepEqual(await within("the response", response), {
    status: 200,
    body: "ab",
    complete: true,
  });
  await within("stop()", stopping);
  assert.equal(await connectionCount(listener), 0);
});

test("overlapping stop() calls during start() are one shutdown that waits for start() to fail and leaves nothing listening", async () => {
  const { root, gateway, created } = unstartedGateway(["vm.sock"]);
  const held = holdNextServer(created);
  const started = assert.rejects(gateway.start(), {
    message: "gateway is stopped",
  });
  await within("the VM listener to open", held.starting);
  const stops = [gateway.stop(), gateway.stop()];
  assert.equal(stops[0], stops[1]);
  held.proceed();
  await within("start() to settle", started);
  await within("stop()", Promise.all(stops));
  await gateway.stop();
  assert.equal(await accepting(path.join(root, "vm.sock")), false);
  assert.equal(await accepting(path.join(root, "admin.sock")), false);
});

function holdRequests(listener: https.Server): {
  parsed: Promise<undefined>;
  deliver: () => void;
} {
  const parsed = signal();
  const delivered = signal();
  defer(delivered.resolve);
  holdEvent(listener, "request", delivered.promise, parsed.resolve);
  return { parsed: parsed.promise, deliver: delivered.resolve };
}

test("a request that is dispatched once stop() has begun is answered with Connection: close", async () => {
  const { socket, gateway, listener } = await startGateway();
  const held = holdRequests(listener);
  const agent = new https.Agent({ keepAlive: true });
  defer(() => {
    agent.destroy();
  });
  const answered = send(
    socket,
    "GET",
    "/shields/dotfiles.git/info/refs?service=git-upload-pack",
    Buffer.alloc(0),
    "github.com",
    {},
    agent,
  );
  await within("the request to be parsed", held.parsed);
  const stopping = gateway.stop();
  held.deliver();
  const response = await within("the response", answered);
  assert.equal(response.status, 200);
  assert.equal(response.headers.connection, "close");
  await within("stop()", stopping);
});

test("stop() waits for a request that is dispatched after it closed the idle connections, so its audit row is written before the database closes", async () => {
  const { socket, gateway, state, instance, auth, listener, closed } =
    await startGateway();
  const events: string[] = [];
  const asked = signal();
  const resume = signal();
  defer(resume.resolve);
  spyOn(auth, "token").mockImplementation(async (): Promise<string> => {
    asked.resolve();
    await resume.promise;
    events.push("token");
    return "ghu_secret";
  });
  const held = holdRequests(listener);
  const { request, response } = open(socket);
  const hungUp = assert.rejects(response, { message: "socket hang up" });
  await within("the request to be parsed", held.parsed);
  const audit = recordFinishes(state);
  const decisions = spyOn(state, "logDecision");
  const shutdown = (async () => {
    await gateway.stop();
    events.push("stopped");
    const rows = auditRows(state, instance);
    state.close();
    return rows;
  })();
  await nextTurn();
  held.deliver();
  await within("the gateway to ask for a token", asked.promise);
  const closing = once(listener, "close");
  request.destroy();
  await within("the client's request to fail", hungUp);
  await within("the gateway's response to close", closed());
  await within("the listener to close", closing);
  // A stop() that does not wait for requests has resolved by now.
  await nextTurn();
  resume.resolve();
  const rows = await within("the gateway to stop", shutdown);
  // Yield so a late write to the closed database is reported while this test
  // is still running.
  await nextTurn();
  assert.deepEqual(
    decisions.mock.results.map(({ type }) => type),
    ["return"],
  );
  assert.deepEqual(events, ["token", "stopped"]);
  assert.deepEqual(rows, [{ outcome: "interrupted", upstreamStatus: null }]);
  assert.deepEqual(audit.calls, [{ status: null, outcome: "interrupted" }]);
});

test("stop() does not sweep a server that had no request in flight, because a second sweep resets a connection still sending its last response", async () => {
  const { gateway, listener } = await startGateway();
  const sweep = spyOn(listener, "closeIdleConnections");
  await gateway.stop();
  assert.equal(sweep.mock.calls.length, 0);
});

test("stop() ends a refused upload that a disabled VM never finishes, without waiting for it", async () => {
  const { socket, gateway, state } = await startGateway();
  const client = tlsConnect({
    path: socket,
    servername: "github.com",
    rejectUnauthorized: false,
  });
  defer(() => {
    client.destroy();
  });
  const failures: Error[] = [];
  client.on("error", (error) => {
    failures.push(error);
  });
  const refused = signal();
  client.once("data", refused.resolve);
  client.write(
    "POST /shields/dotfiles.git/git-receive-pack HTTP/1.1\r\nhost: example.invalid\r\ncontent-length: 1000\r\n\r\nx",
  );
  await within("the refusal", refused.promise);
  state.disable("lima:work", "tester");
  await gateway.refresh();
  await within("stop()", gateway.stop());
});

test("stop() leaves alone a disabled VM's server that has already closed", async () => {
  const { gateway, state, listener } = await startGateway();
  const closed = once(listener, "close");
  state.disable("lima:work", "tester");
  await gateway.refresh();
  await within("the listener to close", closed);
  await nextTurn();
  const cut = spyOn(listener, "closeAllConnections");
  await gateway.stop();
  assert.equal(cut.mock.calls.length, 0);
});

test("start() rejects only after the servers it opened have closed", async () => {
  const { gateway, created } = unstartedGateway([
    "first.sock",
    "gone/second.sock",
  ]);
  const closing = signal();
  const lingering = signal();
  defer(lingering.resolve);
  created.mockImplementationOnce(((
    ...args: Parameters<typeof https.createServer>
  ) => {
    const server = createHttpsServer(...args);
    const close = server.close.bind(server);
    server.close = (...rest: Parameters<typeof server.close>) => {
      closing.resolve();
      return close(...rest);
    };
    holdEvent(server, "close", lingering.promise);
    return server;
  }) as typeof https.createServer);
  let rejected = false;
  const started = (async () => {
    await assert.rejects(gateway.start(), { syscall: "listen" });
    rejected = true;
  })();
  await within("the first server to be closed", closing.promise);
  await nextTurn();
  await nextTurn();
  assert.equal(rejected, false);
  lingering.resolve();
  await within("start() to reject", started);
});

test("stop() cancels the periodic listener refresh", async () => {
  const intervals = mockIntervals();
  const { gateway } = await startGateway();
  const refresh = spyOn(gateway, "refresh");
  intervals.tick(60_000);
  await nextTurn();
  assert.equal(refresh.mock.calls.length, 1);
  await gateway.stop();
  intervals.tick(60_000);
  await nextTurn();
  assert.equal(refresh.mock.calls.length, 1);
});

interface ModelRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  done: boolean;
  ended: Promise<undefined>;
  connection: number;
}

interface ModelStub {
  origin: string;
  requests: ModelRequest[];
  firstChunk: Promise<undefined>;
  connections: { id: number; closed: Promise<undefined> }[];
}

function replyOk(
  _request: IncomingMessage,
  response: ServerResponse,
  entry: ModelRequest,
): void {
  void entry.ended.then(() => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end('{"ok":true}');
  });
}

async function startModelStub(
  respond: (
    request: IncomingMessage,
    response: ServerResponse,
    entry: ModelRequest,
  ) => void = replyOk,
): Promise<ModelStub> {
  const requests: ModelRequest[] = [];
  const connections: ModelStub["connections"] = [];
  const ids = new Map<Socket, number>();
  const firstChunk = signal();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    const ended = signal();
    const entry: ModelRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      rawHeaders: request.rawHeaders,
      body: Buffer.alloc(0),
      done: false,
      ended: ended.promise,
      connection: ids.get(request.socket) ?? -1,
    };
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      firstChunk.resolve();
    });
    request.once("end", () => {
      entry.body = Buffer.concat(chunks);
      entry.done = true;
      ended.resolve();
    });
    requests.push(entry);
    respond(request, response, entry);
  });
  server.on("connection", (socket: Socket) => {
    const closed = signal();
    const id = connections.length + 1;
    ids.set(socket, id);
    connections.push({ id, closed: closed.promise });
    socket.once("close", closed.resolve);
  });
  defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    firstChunk: firstChunk.promise,
    connections,
  };
}

interface ModelReply {
  status: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  complete: boolean;
}

function modelClient(
  socket: string,
  method: string,
  target: string,
  headers: Record<string, string | string[]> = {},
  body?: Buffer | string,
  end = true,
): {
  request: ClientRequest;
  firstData: Promise<undefined>;
  response: Promise<ModelReply>;
} {
  const request = https.request({
    socketPath: socket,
    servername: claudeName,
    rejectUnauthorized: false,
    method,
    path: target,
    agent: false,
    headers: { host: claudeName, ...headers },
  });
  defer(() => {
    request.destroy();
  });
  const firstData = signal();
  const response = new Promise<ModelReply>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        firstData.resolve();
      });
      incoming.once("close", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          statusMessage: incoming.statusMessage ?? "",
          headers: incoming.headers,
          rawHeaders: incoming.rawHeaders,
          body: Buffer.concat(chunks),
          complete: incoming.complete,
        });
      });
    });
  });
  if (end) {
    request.end(body);
  } else if (body !== undefined) {
    request.write(body);
  }
  return { request, firstData: firstData.promise, response };
}

const claudeName = "api.anthropic.com";
const poolHeaders = { authorization: "Bearer cog" };

function claude(
  socket: string,
  method: string,
  target: string,
  headers: Record<string, string | string[]> = {},
  body?: Buffer | string,
): Promise<ModelReply> {
  return modelClient(socket, method, target, headers, body).response;
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      found.push(rawHeaders[index + 1] ?? "");
    }
  }
  return found;
}

function statusOf(reply: string): number {
  return Number(reply.split(" ", 2)[1]);
}

function noSecrets(...shown: unknown[]): void {
  const text = shown
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
  for (const secret of Object.values(tokens)) {
    assert.ok(!text.includes(secret), "a secret is shown");
  }
  assert.ok(!text.includes("made-up"), "a secret is shown");
}

function claudeError(reply: ModelReply): { type: string; message: string } {
  const body = JSON.parse(reply.body.toString()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).toSorted(compareCodeUnits), [
    "error",
    "request_id",
    "type",
  ]);
  assert.equal(body.type, "error");
  return body.error as { type: string; message: string };
}

function pairsOf(rawHeaders: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index] ?? ""}: ${rawHeaders[index + 1] ?? ""}`);
  }
  return lines;
}

function lastRequest(stub: ModelStub): ModelRequest {
  const last = stub.requests.at(-1);
  assert.ok(last);
  return last;
}

function tokenSeen(entry: ModelRequest): string | undefined {
  return Object.entries(tokens).find(
    ([, token]) => entry.headers.authorization === `Bearer ${token}`,
  )?.[0];
}

interface KeepAliveAgent {
  options: { keepAlive?: boolean };
}

const bothAccounts = { alpha: tokens.alpha, bravo: tokens.bravo };

test("a request with the placeholder reaches the provider with the token in the Authorization line's place and spelling, and the rest of the list as sent", async () => {
  const stub = await startModelStub();
  const stderr = captureStderr();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const audit = recordFinishes(state);
  const reply = await exchange(
    socket,
    claudeName,
    "POST /v1/messages?beta=true HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "X-Dup: one\r\n" +
      "aUtHoRiZaTiOn: Bearer cog\r\n" +
      "x-dup: two\r\n" +
      "Anthropic-Beta: a\r\n" +
      "Cookie: session=guest\r\n" +
      "X-Forwarded-For: 198.51.100.7\r\n" +
      "Via: 1.1 guest\r\n" +
      "User-Agent: claude-cli/2.1 (external, cli)\r\n" +
      "Connection: close, TE\r\n" +
      "TE: trailers\r\n" +
      "Content-Length: 2\r\n" +
      "X-Same: 1\r\n" +
      "X-Same: 2\r\n" +
      "anthropic-beta: b\r\n\r\n{}",
  );
  assert.equal(statusOf(reply), 200);
  assert.equal(stub.requests.length, 1);
  const [seen] = stub.requests;
  assert.ok(seen);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/messages?beta=true");
  assert.deepEqual(pairsOf(seen.rawHeaders), [
    "Host: api.anthropic.com",
    "X-Dup: one",
    `aUtHoRiZaTiOn: Bearer ${accountToken}`,
    "x-dup: two",
    "Anthropic-Beta: a",
    "Cookie: session=guest",
    "X-Forwarded-For: 198.51.100.7",
    "Via: 1.1 guest",
    "User-Agent: claude-cli/2.1 (external, cli)",
    "Content-Length: 2",
    "X-Same: 1",
    "X-Same: 2",
    "anthropic-beta: b",
    "Connection: keep-alive",
  ]);
  assert.equal(seen.body.toString(), "{}");
  await within("the audit row", audit.first);
  const [row, ...others] = state.logs(instance.id);
  assert.deepEqual(others, []);
  assert.equal(row?.operation, "model.claude");
  assert.equal(row.repository, null);
  assert.deepEqual(row.refs, []);
  assert.equal(row.allowed, true);
  assert.equal(row.reason, "pool account alpha");
  assert.equal(row.outcome, "completed");
  assert.equal(row.upstreamStatus, 200);
  noSecrets(state.logs(instance.id), stderr, reply);
  assert.deepEqual(stderr, []);
});

test("a request with no Authorization goes to the provider as the client sent it, with no credential, and does not need the pool", async () => {
  const stub = await startModelStub();
  const stderr = captureStderr();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin, pool: "missing" },
  });
  const audit = recordFinishes(state);
  const reply = await exchange(
    socket,
    claudeName,
    "POST /v1/oauth/token?x=1 HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "X-Dup: one\r\n" +
      "Cookie: session=guest\r\n" +
      "x-dup: two\r\n" +
      "Proxy-Authorization: Basic x\r\n" +
      "X-Instance: another-vm\r\n" +
      "Content-Type: application/json\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 7\r\n\r\n" +
      '{"a":1}',
  );
  assert.equal(statusOf(reply), 200);
  const [seen] = stub.requests;
  assert.ok(seen);
  assert.deepEqual(pairsOf(seen.rawHeaders), [
    "Host: api.anthropic.com",
    "X-Dup: one",
    "Cookie: session=guest",
    "x-dup: two",
    "X-Instance: another-vm",
    "Content-Type: application/json",
    "Content-Length: 7",
    "Connection: keep-alive",
  ]);
  assert.equal(seen.url, "/v1/oauth/token?x=1");
  assert.equal(seen.body.toString(), '{"a":1}');
  await within("the audit row", audit.first);
  const [row, ...others] = state.logs(instance.id);
  assert.deepEqual(others, []);
  assert.equal(row?.operation, "model.claude");
  assert.equal(row.allowed, true);
  assert.equal(row.reason, "no credential");
  assert.equal(row.outcome, "completed");
  assert.equal(row.upstreamStatus, 200);
  noSecrets(state.logs(instance.id), stderr);
});

test("targets and bodies reach the provider byte for byte on both routes", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const targets = [
    "/v1/messages",
    "/v1/messages?a={b}&c='d'|[e]^",
    '/v1/messages?a=%zz&b=%2F&c=;&d=,&e=@&f=!&g=$&h=(*)&i=~&j="<>`',
    "/v1/messages?",
    "/v1/x/",
    "//x",
    "/v1/p%2fq/%7e",
    "/v1/%252e%252e/conversations",
    "/a/.;/x",
    '/v1/{x}"<>^`|[]',
    "/v1/messages?x=/../..//",
    "/v1/%C3%BC",
    "/api/claude_cli/bootstrap",
    `/v1/x?${"q=%41&".repeat(2000)}`,
  ];
  const body = Buffer.from(
    JSON.stringify({ messages: [{ content: "x".repeat(400_000) }] }),
  );
  for (const target of targets) {
    for (const headers of [poolHeaders, {}]) {
      const reply = await claude(socket, "POST", target, headers, body);
      assert.equal(reply.status, 200, target);
    }
  }
  assert.deepEqual(
    stub.requests.map(({ url }) => url),
    targets.flatMap((target) => [target, target]),
  );
  for (const entry of stub.requests) {
    assert.equal(digest(entry.body), digest(body));
  }
  const requested = spyOn(http, "request");
  await claude(socket, "POST", targets[2] ?? "", poolHeaders, "{}");
  assert.equal(requested.mock.calls[0]?.[1]?.path, targets[2]);
});

test("a target that is not in origin form is refused, wherever the HTTP parser lets it through", async () => {
  const stub = await startModelStub();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const refused: string[] = [];
  for (const target of [
    "http://api.anthropic.com/v1/messages",
    "*",
    "api.anthropic.com:443",
    "v1/messages",
  ]) {
    const reply = await exchange(
      socket,
      claudeName,
      rawRequest("POST", target, claudeName, "content-length: 0"),
    );
    if (statusOf(reply) === 403) {
      refused.push(target);
    } else {
      assert.equal(statusOf(reply), 400, target);
    }
  }
  assert.ok(refused.length >= 1);
  assert.equal(stub.requests.length, 0);
  for (const row of state.logs(instance.id)) {
    assert.equal(row.operation, "model.claude");
    assert.equal(row.allowed, false);
  }
});

test("the upstream connection is kept alive, reused within a VM and never shared between VMs", async () => {
  const stub = await startModelStub();
  const { socket, instance, state, gateway } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const other = state.register(
    "lima:other",
    path.join(path.dirname(socket), "other.sock"),
    "tester",
  );
  await gateway.refresh();
  const otherSocket = other.socket;
  for (const [vm, headers] of [
    [socket, poolHeaders],
    [otherSocket, poolHeaders],
    [socket, {}],
    [otherSocket, {}],
    [socket, poolHeaders],
    [otherSocket, {}],
  ] as const) {
    assert.equal(
      (await claude(vm, "POST", "/v1/messages", headers, "{}")).status,
      200,
    );
  }
  const used = (n: number): number => stub.requests[n]?.connection ?? -1;
  assert.deepEqual(
    [0, 2, 4].map(used).map((id) => id === used(0)),
    [true, true, true],
  );
  assert.deepEqual(
    [1, 3, 5].map(used).map((id) => id === used(1)),
    [true, true, true],
  );
  assert.notEqual(used(0), used(1));
  assert.equal(stub.connections.length, 2);
  for (const entry of stub.requests) {
    assert.deepEqual(headerValues(entry.rawHeaders, "connection"), [
      "keep-alive",
    ]);
  }
  assert.equal(state.logs(instance.id).length, 3);
});

test("a VM's upstream agent is its own, keeps connections alive, and is destroyed with the VM's listener or the gateway", async () => {
  const stub = await startModelStub();
  const { socket, state, gateway } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const other = state.register(
    "lima:other",
    path.join(path.dirname(socket), "other.sock"),
    "tester",
  );
  await gateway.refresh();
  const requested = spyOn(http, "request");
  await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  await claude(other.socket, "POST", "/v1/messages", poolHeaders, "{}");
  await claude(socket, "POST", "/v1/messages", {}, "{}");
  const agents = requested.mock.calls.map(
    ([, options]) => (options as http.RequestOptions | undefined)?.agent,
  );
  const [first, second, third] = agents;
  assert.ok(first instanceof http.Agent);
  assert.ok(second instanceof http.Agent);
  assert.equal(first, third);
  assert.notEqual(first, second);
  assert.equal((first as unknown as KeepAliveAgent).options.keepAlive, true);
  assert.equal((second as unknown as KeepAliveAgent).options.keepAlive, true);
  assert.equal(stub.connections.length, 2);
  const [one, two] = stub.connections;
  assert.ok(one && two);
  state.disable("lima:work", "tester");
  await gateway.refresh();
  await within("the disabled VM's upstream connection to close", one.closed);
  assert.equal(stub.connections.length, 2);
  await gateway.stop();
  await within("the other VM's upstream connection to close", two.closed);
});

test("a VM that is removed from the active set loses its upstream connections at the next sync", async () => {
  const stub = await startModelStub();
  const { socket, state, gateway } = await startGateway({
    models: { anthropic: stub.origin },
  });
  await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  const [connection] = stub.connections;
  assert.ok(connection);
  state.disable("lima:work", "tester");
  await gateway.refresh();
  await within("the upstream connection to close", connection.closed);
  assert.equal(await accepting(socket), false);
});

for (const route of ["pool", "direct"] as const) {
  test(`a streamed response on the ${route} route reaches the client as it arrives, before the provider has sent the last event`, async () => {
    const release = signal();
    const sent: string[] = [];
    const stub = await startModelStub((_request, response, entry) => {
      void entry.ended.then(async () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write("event: ping\ndata: {}\n\n");
        sent.push("ping");
        await release.promise;
        response.write("event: message_stop\ndata: {}\n\n");
        sent.push("message_stop");
        response.end();
      });
    });
    const { socket, instance, state } = await startGateway({
      models: { anthropic: stub.origin },
    });
    const audit = recordFinishes(state);
    const { firstData, response } = modelClient(
      socket,
      "POST",
      "/v1/messages?beta=true",
      {
        ...(route === "pool" ? poolHeaders : {}),
        accept: "text/event-stream",
      },
      '{"stream":true}',
    );
    await within("the first event", firstData);
    assert.deepEqual(sent, ["ping"]);
    await delay(50);
    assert.deepEqual(sent, ["ping"]);
    release.resolve();
    const reply = await within("the response", response);
    assert.deepEqual(sent, ["ping", "message_stop"]);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-type"], "text/event-stream");
    assert.equal(reply.headers["cache-control"], "no-cache");
    assert.equal(
      reply.body.toString(),
      "event: ping\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
    );
    assert.equal(reply.complete, true);
    await within("the audit row", audit.first);
    assert.deepEqual(auditRows(state, instance), [
      { outcome: "completed", upstreamStatus: 200 },
    ]);
  });
}

test("the request body is streamed to the provider while the client is still sending it", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const first = Buffer.from('{"messages":[');
  const rest = Buffer.alloc(2 * 1_048_576, 0x61);
  const { request, response } = modelClient(
    socket,
    "POST",
    "/v1/messages",
    { ...poolHeaders, "content-type": "application/json" },
    first,
    false,
  );
  await within("the first chunk at the provider", stub.firstChunk);
  const [seen] = stub.requests;
  assert.ok(seen);
  assert.equal(seen.done, false);
  request.write(rest);
  request.end("]}");
  const reply = await within("the response", response);
  assert.equal(reply.status, 200);
  const sent = Buffer.concat([first, rest, Buffer.from("]}")]);
  assert.equal(digest(seen.body), digest(sent));
  assert.equal(seen.headers["transfer-encoding"], "chunked");
});

test("a request with no body is not given chunked framing, and a POST with none gets Content-Length: 0", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  for (const [method, headers] of [
    ["GET", ""],
    ["GET", "authorization: Bearer cog"],
    ["HEAD", ""],
    ["DELETE", "authorization: Bearer cog"],
    ["POST", ""],
    ["POST", "authorization: Bearer cog"],
    ["PUT", "authorization: Bearer cog"],
    ["PATCH", ""],
  ] as const) {
    const reply = await exchange(
      socket,
      claudeName,
      rawRequest(method, "/v1/x", claudeName, headers),
    );
    assert.equal(statusOf(reply), 200, method);
  }
  const seen = stub.requests.map((entry) => ({
    method: entry.method,
    length: headerValues(entry.rawHeaders, "content-length"),
    coding: headerValues(entry.rawHeaders, "transfer-encoding"),
    body: entry.body.length,
  }));
  assert.deepEqual(seen, [
    { method: "GET", length: [], coding: [], body: 0 },
    { method: "GET", length: [], coding: [], body: 0 },
    { method: "HEAD", length: [], coding: [], body: 0 },
    { method: "DELETE", length: [], coding: [], body: 0 },
    { method: "POST", length: ["0"], coding: [], body: 0 },
    { method: "POST", length: ["0"], coding: [], body: 0 },
    { method: "PUT", length: ["0"], coding: [], body: 0 },
    { method: "PATCH", length: ["0"], coding: [], body: 0 },
  ]);
});

test("a client's Content-Length: 0 is forwarded once, and a chunked body stays chunked upstream", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  await claude(socket, "POST", "/v1/x", { "content-length": "0" }, "");
  assert.deepEqual(
    headerValues(stub.requests[0]?.rawHeaders ?? [], "content-length"),
    ["0"],
  );
  const reply = await exchange(
    socket,
    claudeName,
    rawRequest(
      "POST",
      "/v1/x",
      claudeName,
      "transfer-encoding: chunked",
      "5\r\nhello\r\n0\r\n\r\n",
    ),
  );
  assert.equal(statusOf(reply), 200);
  const seen = stub.requests[1];
  assert.ok(seen);
  assert.equal(seen.body.toString(), "hello");
  assert.deepEqual(headerValues(seen.rawHeaders, "transfer-encoding"), [
    "chunked",
  ]);
  assert.deepEqual(headerValues(seen.rawHeaders, "content-length"), []);
});

test("an error answer reaches the client untouched, headers and duplicate values kept, and its rate-limit headers steer the pool", async () => {
  const error = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  });
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response
        .writeHead(429, [
          "content-type",
          "application/json",
          "Retry-After",
          "10800",
          "x-should-retry",
          "false",
          "anthropic-ratelimit-unified-status",
          "rejected",
          "anthropic-ratelimit-unified-reset",
          "1795500000",
          "request-id",
          "req_011",
          "x-other-request-id",
          "kept",
          "X-Dup",
          "a=1",
          "x-dup",
          "b=2",
          "Connection",
          "x-hop",
          "x-hop",
          "1",
        ])
        .end(error);
    });
  });
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const audit = recordFinishes(state);
  const reply = await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal(reply.status, 429);
  assert.equal(reply.body.toString(), error);
  assert.deepEqual(
    pairsOf(reply.rawHeaders).filter(
      (line) =>
        !/^(content-length|date|connection|keep-alive|transfer-encoding):/iu.test(
          line,
        ),
    ),
    [
      "content-type: application/json",
      "Retry-After: 10800",
      "x-should-retry: false",
      "anthropic-ratelimit-unified-status: rejected",
      "anthropic-ratelimit-unified-reset: 1795500000",
      "request-id: req_011",
      "x-other-request-id: kept",
      "X-Dup: a=1",
      "X-Dup: b=2",
    ],
  );
  assert.equal(reply.headers["x-hop"], undefined);
  await within("the audit row", audit.first);
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "completed", upstreamStatus: 429 },
  ]);
});

test("the provider's reason phrase reaches the client", async () => {
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response.writeHead(529, "Overloaded", {
        "content-type": "application/json",
      });
      response.end("{}");
    });
  });
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const reply = await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal(reply.status, 529);
  assert.equal(reply.statusMessage, "Overloaded");
});

test("a reason phrase that cannot be relayed is dropped, and the client still gets the status and the body, from the provider and from GitHub", async () => {
  const answer = (socket: Socket): void => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 200 a\u{1}b\r\ncontent-length: 2\r\n\r\nok");
    });
  };
  const provider = rawUpstream(answer);
  defer(() => {
    provider.closeAllConnections();
    provider.close();
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const { socket } = await startGateway({
    connection: answer,
    models: { anthropic: `http://127.0.0.1:${String(address.port)}` },
  });
  for (const headers of [poolHeaders, {}]) {
    const reply = await claude(socket, "POST", "/v1/messages", headers, "{}");
    assert.equal(reply.status, 200);
    assert.equal(reply.statusMessage, "OK");
    assert.equal(reply.body.toString(), "ok");
  }
  const github = await send(socket, "GET", "/shields/dotfiles");
  assert.equal(github.status, 200);
  assert.equal(github.body, "ok");
});

test("an upstream that answers 101 Switching Protocols gets a 503 and a gateway-error row, on both routes", async () => {
  const provider = rawUpstream((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
      );
    });
  });
  defer(() => {
    provider.closeAllConnections();
    provider.close();
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  captureStderr();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: `http://127.0.0.1:${String(address.port)}` },
  });
  for (const headers of [poolHeaders, {}]) {
    const reply = await within(
      "the answer",
      claude(socket, "GET", "/v1/models", headers),
    );
    assert.equal(reply.status, 503);
    assert.equal(reply.headers["x-should-retry"], undefined);
  }
  assert.deepEqual(
    state.logs(instance.id).map(({ outcome }) => outcome),
    ["gateway-error", "gateway-error"],
  );
});

test("a client that pipelines body-less requests draws no EventEmitter warning from the relay", async () => {
  const stub = await startModelStub();
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.message);
  };
  process.on("warning", onWarning);
  defer(() => {
    process.off("warning", onWarning);
  });
  captureStderr();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const request = (close: boolean): string =>
    `GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer cog\r\n${close ? "Connection: close\r\n" : ""}\r\n`;
  const reply = await exchange(
    socket,
    "api.anthropic.com",
    request(false).repeat(30) + request(true),
  );
  assert.equal(reply.match(/^HTTP\/1\.1 200/gm)?.length, 31);
  assert.deepEqual(warnings, []);
});

test("a compressed answer reaches the client as the provider's bytes with its content-encoding, on both routes", async () => {
  const plain = Buffer.from('{"hello":"world"}'.repeat(200));
  const compressed = gzipSync(plain);
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response
        .writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(compressed.length),
        })
        .end(compressed);
    });
  });
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  for (const headers of [poolHeaders, {}]) {
    const reply = await claude(
      socket,
      "POST",
      "/v1/messages",
      { ...headers, "accept-encoding": "gzip" },
      "{}",
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-encoding"], "gzip");
    assert.equal(reply.headers["content-length"], String(compressed.length));
    assert.equal(digest(reply.body), digest(compressed));
    assert.equal(digest(gunzipSync(reply.body)), digest(plain));
  }
  assert.equal(stub.requests[0]?.headers["accept-encoding"], "gzip");
});

test("a client that leaves mid-stream is audited as interrupted and the upstream connection is closed, not reused", async () => {
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ping\ndata: {}\n\n");
    });
  });
  const { socket, instance, state, closed } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const audit = recordFinishes(state);
  const { request, firstData } = modelClient(
    socket,
    "POST",
    "/v1/messages",
    poolHeaders,
    "{}",
  );
  await within("the first event", firstData);
  request.destroy();
  await within("the audit row", audit.first);
  const [connection] = stub.connections;
  assert.ok(connection);
  await within("the upstream connection to close", connection.closed);
  await within("the gateway's response to close", closed());
  assert.deepEqual(auditRows(state, instance), [
    { outcome: "interrupted", upstreamStatus: 200 },
  ]);
});

test("a client that leaves mid-upload closes the upstream connection, and the next request opens another", async () => {
  const stub = await startModelStub();
  const { socket, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const audit = recordFinishes(state);
  const { request, response } = modelClient(
    socket,
    "POST",
    "/v1/messages",
    poolHeaders,
    Buffer.alloc(1000, 0x61),
    false,
  );
  await within("the first chunk at the provider", stub.firstChunk);
  request.destroy();
  await Promise.allSettled([response]);
  await within("the audit row", audit.first);
  const [connection] = stub.connections;
  assert.ok(connection);
  await within("the upstream connection to close", connection.closed);
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", {}, "{}")).status,
    200,
  );
  assert.equal(stub.connections.length, 2);
  assert.equal(stub.requests.at(-1)?.connection, 2);
});

test("a provider that fails mid-request is a 503 in the provider's error shape that the client may retry, and a gateway-error row, and nothing secret is reported", async () => {
  const stub = await startModelStub((request, _response, entry) => {
    void entry.ended.then(() => {
      request.socket.destroy();
    });
  });
  const stderr = captureStderr();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  for (const headers of [poolHeaders, {}]) {
    const reply = await claude(socket, "POST", "/v1/messages", headers, "{}");
    assert.equal(reply.status, 503);
    assert.equal(reply.headers["x-should-retry"], undefined);
    assert.equal(reply.headers["content-type"], "application/json");
    assert.deepEqual(claudeError(reply), {
      type: "api_error",
      message: "cog gateway: gateway request failed",
    });
    noSecrets(reply.body.toString());
  }
  assert.deepEqual(
    state.logs(instance.id).map(({ outcome, operation }) => ({
      outcome,
      operation,
    })),
    [
      { outcome: "gateway-error", operation: "model.claude" },
      { outcome: "gateway-error", operation: "model.claude" },
    ],
  );
  noSecrets(state.logs(instance.id), stderr);
});

test("refusals are 403s in the provider's error shape that tell the client not to retry, never 401, and carry the gateway's request id", async () => {
  const stub = await startModelStub();
  const { socket, instance, state } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const requests: [string, string, Record<string, string | string[]>][] = [
    ["POST", "/v1/messages", { ...poolHeaders, "x-api-key": "guest-key" }],
    ["POST", "/v1/messages", { "x-api-key": "guest-key" }],
    ["POST", "/v1/messages", { "X-Api-Key": "" }],
    ["POST", "/v1/messages", { authorization: "Bearer guest-token" }],
    ["POST", "/v1/messages", { authorization: "bearer cog" }],
    ["POST", "/v1/messages", { authorization: "Bearer  cog" }],
    ["POST", "/v1/messages", { authorization: "cog" }],
    ["POST", "/v1/messages", { authorization: "Basic Y29nOg==" }],
    ["POST", "/v1/messages", { authorization: ["Bearer cog", "Bearer cog"] }],
    [
      "POST",
      "/v1/messages",
      { authorization: ["Bearer guest-token", "Bearer cog"] },
    ],
  ];
  for (const [method, target, headers] of requests) {
    const reply = await claude(socket, method, target, headers, "{}");
    assert.equal(reply.status, 403, JSON.stringify(headers));
    assert.equal(reply.headers["content-type"], "application/json");
    assert.equal(reply.headers["x-should-retry"], "false");
    assert.equal(claudeError(reply).type, "permission_error");
    assert.match(claudeError(reply).message, /^cog gateway: ./);
    assert.ok(!reply.body.toString().includes("guest-key"));
    assert.ok(!reply.body.toString().includes("guest-token"));
  }
  const framing = [
    "content-length: 2\r\ncontent-length: 2",
    "content-length: 2\r\ntransfer-encoding: chunked",
  ];
  for (const extra of framing) {
    const reply = await exchange(
      socket,
      claudeName,
      rawRequest("POST", "/v1/messages", claudeName, extra, "{}"),
    );
    assert.ok([400, 403].includes(statusOf(reply)), extra);
  }
  const duplicated = await exchange(
    socket,
    claudeName,
    rawRequest(
      "POST",
      "/v1/messages",
      claudeName,
      "host: api.anthropic.com\r\ncontent-length: 2",
      "{}",
    ),
  );
  assert.ok([400, 403].includes(statusOf(duplicated)));
  assert.equal(stub.requests.length, 0);
  const rows = state.logs(instance.id);
  assert.ok(rows.length >= requests.length);
  for (const row of rows) {
    assert.equal(row.allowed, false);
    assert.equal(row.operation, "model.claude");
    assert.equal(row.repository, null);
    assert.equal(row.outcome, "denied");
  }
  const reply = await claude(socket, "POST", "/v1/messages", {
    "x-api-key": "k",
  });
  const [latest] = state.logs(instance.id);
  assert.equal(
    (JSON.parse(reply.body.toString()) as { request_id: string }).request_id,
    latest?.id,
  );
});

test("a GET or HEAD with a body is refused before anything is forwarded", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  for (const [method, headers] of [
    ["GET", "content-length: 5"],
    ["GET", "authorization: Bearer cog\r\ncontent-length: 5"],
    ["HEAD", "content-length: 5"],
    ["GET", "transfer-encoding: chunked"],
  ] as const) {
    const reply = await exchange(
      socket,
      claudeName,
      rawRequest(method, "/v1/models", claudeName, headers, "abcde"),
    );
    assert.equal(statusOf(reply), 403, `${method} ${headers}`);
  }
  assert.equal(stub.requests.length, 0);
});

test("a chunked body on a method that the client sends unframed is refused, and the same body with a Content-Length arrives as one request", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const hidden =
    "GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nx-api-key: k\r\n\r\n";
  const chunked = `${hidden.length.toString(16)}\r\n${hidden}\r\n0\r\n\r\n`;
  for (const method of ["DELETE", "OPTIONS", "TRACE"]) {
    for (const credential of ["", "authorization: Bearer cog"]) {
      const reply = await exchange(
        socket,
        claudeName,
        rawRequest(
          method,
          "/v1/x",
          claudeName,
          ["transfer-encoding: chunked", credential]
            .filter(Boolean)
            .join("\r\n"),
          chunked,
        ),
      );
      assert.equal(statusOf(reply), 403, `${method} ${credential}`);
    }
  }
  assert.equal(stub.requests.length, 0);
  for (const method of ["DELETE", "OPTIONS"]) {
    const reply = await exchange(
      socket,
      claudeName,
      rawRequest(
        method,
        "/v1/x",
        claudeName,
        `content-length: ${String(hidden.length)}`,
        hidden,
      ),
    );
    assert.equal(statusOf(reply), 200, method);
  }
  assert.deepEqual(
    stub.requests.map(({ method, url, body }) => [
      method,
      url,
      body.toString(),
    ]),
    [
      ["DELETE", "/v1/x", hidden],
      ["OPTIONS", "/v1/x", hidden],
    ],
  );
});

test("the health path is answered locally, with no credential, whatever the pool's state, and audited like the GitHub one", async () => {
  captureStderr();
  for (const pool of [undefined, "missing", "unset", {}] as const) {
    const stub = await startModelStub();
    const { socket, instance, state } = await startGateway({
      models: { anthropic: stub.origin, ...(pool ? { pool } : {}) },
    });
    const audit = recordFinishes(state);
    const reply = await claude(socket, "GET", "/__cog__/health");
    assert.equal(reply.status, 200, JSON.stringify(pool));
    assert.equal(reply.body.toString(), "cog ready\n");
    assert.equal(reply.headers["content-type"], "text/plain");
    await within("the audit row", audit.first);
    assert.equal(stub.requests.length, 0);
    const [row, ...others] = state.logs(instance.id);
    assert.deepEqual(others, []);
    assert.equal(row?.operation, "public.read");
    assert.equal(row.repository, null);
    assert.equal(row.allowed, true);
    assert.equal(row.reason, "anonymous read");
    assert.equal(row.outcome, "completed");
    assert.equal(row.upstreamStatus, 200);
  }
});

test("only the exact health target is answered locally", async () => {
  const stub = await startModelStub();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  assert.equal(
    (await claude(socket, "GET", "/__cog__/health?x=1")).status,
    200,
  );
  assert.equal(stub.requests[0]?.url, "/__cog__/health?x=1");
  assert.equal((await claude(socket, "POST", "/__cog__/health")).status, 200);
  assert.equal(stub.requests[1]?.method, "POST");
  assert.equal(stub.requests.length, 2);
});

const unusablePools: [string, PoolSpec | "empty" | "invalid", string | null][] =
  [
    ["no pool setting", "unset", null],
    ["a pool directory that does not exist", "missing", null],
    ["a pool directory with no account", "empty", null],
    [
      "an account file that is not a token",
      "invalid",
      "account alpha must hold a token that starts with sk-ant-oat",
    ],
  ];

for (const [name, mode, reason] of unusablePools) {
  test(`with ${name} the pool route answers 503, while direct requests, health and GitHub are unaffected`, async () => {
    const stub = await startModelStub();
    const stderr = captureStderr();
    const pool: PoolSpec =
      mode === "empty"
        ? {}
        : mode === "invalid"
          ? { alpha: "sk-wrong-made-up-alpha-token" }
          : mode;
    const { socket, instance, state, incoming } = await startGateway({
      models: { anthropic: stub.origin, pool },
    });
    const refused = await claude(
      socket,
      "POST",
      "/v1/messages",
      poolHeaders,
      "{}",
    );
    assert.equal(refused.status, 503);
    assert.equal(refused.headers["content-type"], "application/json");
    assert.equal(refused.headers["x-should-retry"], "false");
    assert.deepEqual(claudeError(refused), {
      type: "api_error",
      message:
        mode === "unset" || mode === "missing" || mode === "empty"
          ? "cog gateway: the Claude pool is not configured"
          : "cog gateway: the Claude pool is not usable",
    });
    const [row, ...others] = state.logs(instance.id);
    assert.deepEqual(others, []);
    assert.equal(row?.operation, "model.claude");
    assert.equal(row.allowed, false);
    assert.equal(row.outcome, "denied");
    assert.equal(stub.requests.length, 0);
    assert.equal(
      (await claude(socket, "POST", "/v1/messages", {}, "{}")).status,
      200,
    );
    assert.equal(stub.requests.length, 1);
    assert.equal((await claude(socket, "GET", "/__cog__/health")).status, 200);
    assert.equal((await send(socket, "GET", "/shields/dotfiles")).status, 200);
    assert.equal(incoming.length, 1);
    assert.deepEqual(
      stderr,
      reason === null ? [] : [`cog: Claude pool unavailable: ${reason}\n`],
    );
    noSecrets(state.logs(instance.id), stderr, refused.body.toString());
  });
}

test("the pool directory is read again when /sync is requested and not for each request, an account added or removed is seen, and the stderr line is written once per changed reason", async () => {
  const stub = await startModelStub();
  const stderr = captureStderr();
  const { root, poolDirectory, socket, state, instance } = await startGateway({
    models: { anthropic: stub.origin, pool: { alpha: tokens.alpha } },
  });
  const adminSocket = path.join(root, "admin.sock");
  const post = async (): Promise<ModelReply> =>
    claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), "alpha");
  const rank = (name: string): string =>
    createHash("sha256").update(`${instance.id}\0${name}`).digest("hex");
  let ahead = "ahead";
  for (let n = 0; compareCodeUnits(rank(ahead), rank("alpha")) > 0; n += 1) {
    ahead = `ahead-${String(n)}`;
  }
  writeFileSync(path.join(poolDirectory, ahead), tokens.bravo, { mode: 0o600 });
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), "alpha");
  rmSync(path.join(poolDirectory, ahead));
  writeFileSync(path.join(poolDirectory, "bravo"), tokens.bravo, {
    mode: 0o600,
  });
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), "alpha");
  rmSync(path.join(poolDirectory, "alpha"));
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), "bravo");
  assert.deepEqual(stderr, []);
  chmodSync(path.join(poolDirectory, "bravo"), 0o640);
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 503);
  assert.equal(await requestSync(adminSocket), 200);
  const open =
    "cog: Claude pool unavailable: account bravo is accessible to group or other\n";
  assert.deepEqual(stderr, [open]);
  chmodSync(path.join(poolDirectory, "bravo"), 0o600);
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 200);
  assert.deepEqual(stderr, [open]);
  rmSync(path.join(poolDirectory, "bravo"));
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 503);
  rmSync(poolDirectory, { recursive: true });
  assert.equal(await requestSync(adminSocket), 200);
  assert.deepEqual(stderr, [open]);
  writePool(poolDirectory, { bravo: tokens.bravo });
  chmodSync(path.join(poolDirectory, "bravo"), 0o640);
  assert.equal(await requestSync(adminSocket), 200);
  assert.deepEqual(stderr, [open, open]);
  noSecrets(stderr, state.logs(instance.id));
});

test("one bad entry disables the whole pool, and nothing of the file reaches stderr, the audit or the client", async () => {
  const stub = await startModelStub();
  const stderr = captureStderr();
  const { socket, instance, state } = await startGateway({
    models: {
      anthropic: stub.origin,
      pool: {
        alpha: tokens.alpha,
        bravo: `${tokens.bravo}\nsecond-made-up-line`,
      },
    },
  });
  const reply = await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal(reply.status, 503);
  assert.equal(stub.requests.length, 0);
  assert.deepEqual(stderr, [
    "cog: Claude pool unavailable: account bravo must hold one token of visible ASCII characters\n",
  ]);
  noSecrets(state.logs(instance.id), stderr, reply.body.toString());
});

test("the account a VM uses changes after a response that reports utilization of 0.95, and after a rejected 429", async () => {
  for (const kind of ["utilization", "rejected"] as const) {
    const stub = await startModelStub((_request, response, entry) => {
      void entry.ended.then(() => {
        const first = stub.requests.length === 1;
        const reset = String(Math.floor(Date.now() / 1000) + 3600);
        if (first && kind === "utilization") {
          response
            .writeHead(200, {
              "anthropic-ratelimit-unified-5h-utilization": "0.95",
              "anthropic-ratelimit-unified-5h-reset": reset,
            })
            .end("{}");
        } else if (first) {
          response
            .writeHead(429, {
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-reset": reset,
            })
            .end("{}");
        } else {
          response.writeHead(200).end("{}");
        }
      });
    });
    const { socket } = await startGateway({
      models: { anthropic: stub.origin, pool: bothAccounts },
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      statuses.push(
        (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}"))
          .status,
      );
    }
    assert.deepEqual(statuses, [
      kind === "utilization" ? 200 : 429,
      200,
      200,
      200,
    ]);
    const used = stub.requests.map(tokenSeen);
    assert.notEqual(used[0], undefined);
    assert.notEqual(used[1], used[0], kind);
    assert.deepEqual(used.slice(1), [used[1], used[1], used[1]], kind);
  }
});

test("a response to a request sent before an account was held does not release the hold", async () => {
  const release = signal();
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const stub = await startModelStub((request, response, entry) => {
    if (entry.url === "/slow") {
      void release.promise.then(() => {
        response.writeHead(200).end("{}");
      });
    } else if (entry.url === "/limit") {
      void entry.ended.then(() => {
        response
          .writeHead(429, {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": reset,
          })
          .end("{}");
      });
    } else {
      replyOk(request, response, entry);
    }
  });
  const { socket } = await startGateway({
    models: { anthropic: stub.origin, pool: bothAccounts },
  });
  const slow = claude(socket, "POST", "/slow", poolHeaders, "{}");
  await within("the first request at the provider", stub.firstChunk);
  await delay(20);
  assert.equal(
    (await claude(socket, "POST", "/limit", poolHeaders, "{}")).status,
    429,
  );
  release.resolve();
  assert.equal((await slow).status, 200);
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  const used = stub.requests.map(tokenSeen);
  assert.equal(used[1], used[0]);
  assert.notEqual(used[2], used[0]);
});

function firstAccount(instanceId: string): string | undefined {
  const rank = (name: string): string =>
    createHash("sha256").update(`${instanceId}\0${name}`).digest("hex");
  return Object.keys(bothAccounts).toSorted((a, b) =>
    compareCodeUnits(rank(a), rank(b)),
  )[0];
}

test("a VM stays on its account while the account has quota, and each VM keeps its own order", async () => {
  const stub = await startModelStub();
  const { socket, instance, state, gateway } = await startGateway({
    models: { anthropic: stub.origin, pool: bothAccounts },
  });
  const others = Array.from({ length: 8 }, (_unused, index) =>
    state.register(
      `lima:vm${String(index)}`,
      path.join(path.dirname(socket), `vm${String(index)}.sock`),
      "tester",
    ),
  );
  await gateway.refresh();
  for (const vm of [instance, ...others]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await claude(vm.socket, "POST", "/v1/messages", poolHeaders, "{}");
    }
    const first = firstAccount(vm.id);
    assert.deepEqual(stub.requests.slice(-3).map(tokenSeen), [
      first,
      first,
      first,
    ]);
  }
});

test("a stale kept-alive connection is retried once on a fresh one for a request with no body, and a request with a body is not replayed", async () => {
  let reused = 0;
  const stub = await startModelStub((request, response, entry) => {
    if (
      entry.connection === 1 &&
      stub.requests.filter((other) => other.connection === 1).length > 1
    ) {
      reused += 1;
      request.socket.destroy();
      return;
    }
    replyOk(request, response, entry);
  });
  const { socket } = await startGateway({
    models: { anthropic: stub.origin },
  });
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  const retried = await claude(socket, "GET", "/v1/models", poolHeaders);
  assert.equal(retried.status, 200);
  assert.equal(reused, 1);
  assert.deepEqual(
    stub.requests.map(({ method, connection }) => [method, connection]),
    [
      ["POST", 1],
      ["GET", 1],
      ["GET", 2],
    ],
  );
  const seen = stub.requests[2];
  assert.ok(seen);
  assert.deepEqual(headerValues(seen.rawHeaders, "authorization"), [
    `Bearer ${accountToken}`,
  ]);
  const second = await claude(
    socket,
    "POST",
    "/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(second.status, 200);
  assert.equal(stub.requests.at(-1)?.connection, 2);
  const third = await startModelStub((request, response, entry) => {
    if (
      third.requests.filter((other) => other.connection === 1).length > 1 &&
      entry.connection === 1
    ) {
      request.socket.destroy();
      return;
    }
    replyOk(request, response, entry);
  });
  captureStderr();
  const other = await startGateway({ models: { anthropic: third.origin } });
  assert.equal(
    (await claude(other.socket, "POST", "/v1/messages", poolHeaders, "{}"))
      .status,
    200,
  );
  const failed = await claude(
    other.socket,
    "POST",
    "/v1/messages",
    poolHeaders,
    '{"a":1}',
  );
  assert.equal(failed.status, 503);
  assert.equal(third.requests.length, 2);
  assert.equal(claudeError(failed).type, "api_error");
});

test("a body-less request that is not safe is not sent again after a reset on a reused connection", async () => {
  const stub = await startModelStub((request, response, entry) => {
    if (entry.url === "/reset") {
      request.socket.destroy();
      return;
    }
    replyOk(request, response, entry);
  });
  captureStderr();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    assert.equal(
      (await claude(socket, "GET", "/v1/models", poolHeaders)).status,
      200,
    );
    const before = stub.requests.length;
    const reply = await claude(socket, method, "/reset", poolHeaders);
    assert.equal(reply.status, 503, method);
    assert.equal(stub.requests.length, before + 1, method);
  }
});

test("a request with no body is sent again once after a reset on a reused connection, and not after a reset on the fresh one", async () => {
  const stub = await startModelStub((request, response, entry) => {
    if (stub.requests.length === 1) {
      replyOk(request, response, entry);
      return;
    }
    request.socket.destroy();
  });
  captureStderr();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  assert.equal(
    (await claude(socket, "GET", "/v1/models", poolHeaders)).status,
    200,
  );
  assert.equal(
    (await claude(socket, "GET", "/v1/models", poolHeaders)).status,
    503,
  );
  assert.equal(stub.requests.length, 3);
});

test("a disabled VM is refused on both routes and on health, and its socket no longer answers", async () => {
  const stub = await startModelStub();
  const { socket, instance, state, gateway } = await startGateway({
    models: { anthropic: stub.origin },
  });
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  const byId = state.byId.bind(state);
  const refusal = spyOn(state, "byId").mockImplementation((id: string) => {
    const found = byId(id);
    return found && { ...found, disabled: true };
  });
  const refused = [
    await claude(socket, "POST", "/v1/messages", poolHeaders, "{}"),
    await claude(socket, "POST", "/v1/messages", {}, "{}"),
    await claude(socket, "GET", "/__cog__/health"),
  ];
  refusal.mockRestore();
  for (const reply of refused) {
    assert.equal(reply.status, 403);
    assert.equal(reply.headers["x-should-retry"], "false");
    assert.match(reply.body.toString(), /VM access has been revoked/);
  }
  assert.equal(stub.requests.length, 1);
  assert.deepEqual(
    state
      .logs(instance.id)
      .filter(({ allowed }) => !allowed)
      .map(({ operation }) => operation),
    ["model.claude", "model.claude", "model.claude"],
  );
  state.disable("lima:work", "tester");
  await gateway.refresh();
  assert.equal(await accepting(socket), false);
});

test("model requests use a 600 s upstream idle timeout on both routes, and GitHub requests keep 60 s", async () => {
  const stub = await startModelStub();
  const { socket, origin } = await startGateway({
    models: { anthropic: stub.origin },
  });
  const requested = spyOn(http, "request");
  assert.equal((await send(socket, "GET", "/shields/dotfiles")).status, 200);
  await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  await claude(socket, "POST", "/v1/messages", {}, "{}");
  const timeouts = requested.mock.calls.map(([target, options]) => [
    String(target instanceof URL ? target.origin : target),
    (options as http.RequestOptions | undefined)?.timeout,
  ]);
  assert.deepEqual(timeouts, [
    [origin, 60_000],
    [stub.origin, 600_000],
    [stub.origin, 600_000],
  ]);
});

test("an upstream setting with a path, credentials, a query or a fragment is refused, and the request fails closed", async () => {
  const stub = await startModelStub();
  for (const bad of [
    `${stub.origin}/v1`,
    `${stub.origin}?x=1`,
    `${stub.origin}#x`,
    `http://user:pass@${new URL(stub.origin).host}`,
    "ftp://127.0.0.1:1",
  ]) {
    captureStderr();
    const { socket, state, instance } = await startGateway({
      models: { anthropic: bad },
    });
    assert.equal(
      (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
      503,
      bad,
    );
    assert.equal(
      (await claude(socket, "POST", "/v1/messages", {}, "{}")).status,
      503,
      bad,
    );
    assert.equal(
      state.logs(instance.id).every((row) => row.outcome === "gateway-error"),
      true,
    );
  }
  assert.equal(stub.requests.length, 0);
});

test("a TLS upstream is reached with its own keep-alive agent per VM", async () => {
  const seen: { socket: number; host: string | undefined }[] = [];
  const sockets = new Map<unknown, number>();
  const upstream = https.createServer(
    { cert: readFileSync(certificate), key: readFileSync(key) },
    (request, response) => {
      if (!sockets.has(request.socket)) {
        sockets.set(request.socket, sockets.size + 1);
      }
      seen.push({
        socket: sockets.get(request.socket) ?? 0,
        host: request.headers.host,
      });
      request.resume();
      response.writeHead(200, { "content-length": "2" }).end("ok");
    },
  );
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  defer(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => {
      upstream.close(() => {
        resolve();
      });
    });
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const NativeAgent = https.Agent;
  const mutable = https as { Agent: unknown };
  mutable.Agent = class extends NativeAgent {
    constructor(options?: https.AgentOptions) {
      super({
        ...options,
        ca: readFileSync(certificate),
        checkServerIdentity: () => {
          return;
        },
      });
    }
  };
  defer(() => {
    mutable.Agent = NativeAgent;
  });
  const { socket, state, gateway } = await startGateway({
    models: { anthropic: `https://127.0.0.1:${String(address.port)}` },
  });
  const other = state.register(
    "lima:other",
    path.join(path.dirname(socket), "other.sock"),
    "tester",
  );
  await gateway.refresh();
  for (const vm of [socket, other.socket, socket, other.socket]) {
    assert.equal(
      (await claude(vm, "POST", "/v1/messages", poolHeaders, "{}")).status,
      200,
    );
  }
  assert.deepEqual(
    seen.map((entry) => entry.socket),
    [1, 2, 1, 2],
  );
  assert.equal(seen[0]?.host, claudeName);
});

test("a hold survives a reload that finds the pool unusable in between", async () => {
  let rejectNext = true;
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const stub = await startModelStub((request, response, entry) => {
    if (rejectNext) {
      rejectNext = false;
      void entry.ended.then(() => {
        response
          .writeHead(429, [
            "content-type",
            "application/json",
            "anthropic-ratelimit-unified-status",
            "rejected",
            "anthropic-ratelimit-unified-reset",
            reset,
          ])
          .end("{}");
      });
      return;
    }
    replyOk(request, response, entry);
  });
  captureStderr();
  const { root, poolDirectory, socket } = await startGateway({
    models: {
      anthropic: stub.origin,
      pool: { alpha: tokens.alpha, bravo: tokens.bravo },
    },
  });
  const adminSocket = path.join(root, "admin.sock");
  const post = async (): Promise<ModelReply> =>
    claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal((await post()).status, 429);
  const first = tokenSeen(lastRequest(stub));
  assert.equal((await post()).status, 200);
  const second = tokenSeen(lastRequest(stub));
  assert.notEqual(second, first);
  chmodSync(path.join(poolDirectory, "alpha"), 0o644);
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 503);
  chmodSync(path.join(poolDirectory, "alpha"), 0o600);
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), second);
});

test("a hold is forgotten once every account is removed, with the tokens it belonged to", async () => {
  let rejectNext = true;
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const stub = await startModelStub((request, response, entry) => {
    if (rejectNext) {
      rejectNext = false;
      void entry.ended.then(() => {
        response
          .writeHead(429, [
            "content-type",
            "application/json",
            "anthropic-ratelimit-unified-status",
            "rejected",
            "anthropic-ratelimit-unified-reset",
            reset,
          ])
          .end("{}");
      });
      return;
    }
    replyOk(request, response, entry);
  });
  captureStderr();
  const pool = { alpha: tokens.alpha, bravo: tokens.bravo };
  const { root, poolDirectory, socket } = await startGateway({
    models: { anthropic: stub.origin, pool },
  });
  const adminSocket = path.join(root, "admin.sock");
  const post = async (): Promise<ModelReply> =>
    claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal((await post()).status, 429);
  const first = tokenSeen(lastRequest(stub));
  assert.equal((await post()).status, 200);
  assert.notEqual(tokenSeen(lastRequest(stub)), first);
  rmSync(path.join(poolDirectory, "alpha"));
  rmSync(path.join(poolDirectory, "bravo"));
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 503);
  writePool(poolDirectory, pool);
  assert.equal(await requestSync(adminSocket), 200);
  assert.equal((await post()).status, 200);
  assert.equal(tokenSeen(lastRequest(stub)), first);
});

test("response headers reach the client before the first body byte", async () => {
  const release = signal();
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(async () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      await release.promise;
      response.end("data: 1\n\n");
    });
  });
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const client = modelClient(socket, "POST", "/v1/messages", poolHeaders, "{}");
  const head = Promise.withResolvers<number>();
  client.request.once("response", (incoming) => {
    head.resolve(incoming.statusCode ?? 0);
  });
  assert.equal(await within("the response head", head.promise), 200);
  release.resolve();
  assert.equal((await client.response).body.toString(), "data: 1\n\n");
});

test("a reset on a fresh connection is not retried", async () => {
  const stub = await startModelStub((request) => {
    request.socket.destroy();
  });
  captureStderr();
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const reply = await claude(socket, "GET", "/v1/models", poolHeaders);
  assert.equal(reply.status, 503);
  assert.equal(stub.requests.length, 1);
});

test("an upstream request that times out is destroyed and the client gets 503", async () => {
  const stub = await startModelStub(() => {
    return;
  });
  captureStderr();
  const requested = spyOn(http, "request");
  const { socket } = await startGateway({ models: { anthropic: stub.origin } });
  const pending = claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  await within("the upstream request", stub.firstChunk);
  const upstream = requested.mock.results.at(-1)?.value as http.ClientRequest;
  upstream.emit("timeout");
  assert.equal((await within("the answer", pending)).status, 503);
  assert.equal(upstream.destroyed, true);
});

test("a VM disabled while a request with no body is in flight does not have it sent again", async () => {
  const stub = await startModelStub((request, response, entry) => {
    if (entry.url === "/slow") {
      return;
    }
    replyOk(request, response, entry);
  });
  captureStderr();
  const { socket, state, gateway } = await startGateway({
    models: { anthropic: stub.origin },
  });
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  const pending = (async (): Promise<void> => {
    try {
      await claude(socket, "GET", "/slow", poolHeaders);
    } catch {
      return;
    }
  })();
  while (stub.requests.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  state.disable("lima:work", "tester");
  await gateway.refresh();
  await within("the answer", pending);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.connections.length, 1);
});

test("uploads whose upstream request cannot be created, in sequence on one connection, leave no listeners behind on its socket", async () => {
  const stub = await startModelStub();
  const { socket, listener } = await startGateway({
    models: { anthropic: stub.origin },
  });
  captureStderr();
  spyOn(http, "request").mockImplementation(() => {
    throw new Error("the upstream request cannot be created");
  });
  const watched = watchCloseListeners(listener);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  defer(() => {
    agent.destroy();
  });
  for (let round = 0; round < 8; round += 1) {
    const request = https.request({
      socketPath: socket,
      servername: claudeName,
      rejectUnauthorized: false,
      agent,
      method: "POST",
      path: "/v1/messages",
      headers: { host: claudeName, ...poolHeaders },
    });
    const failed = signal();
    const answered = new Promise<number>((resolve, reject) => {
      request.once("error", reject);
      request.once("response", (incoming) => {
        failed.resolve();
        incoming.resume();
        incoming.once("end", () => {
          resolve(incoming.statusCode ?? 0);
        });
      });
    });
    request.write("{");
    await within("the gateway to answer the failed upload", failed.promise);
    request.end("}");
    assert.equal(await within("the response to end", answered), 503);
  }
  assert.equal(stub.requests.length, 0);
  assert.equal(watched.connections.size, 1);
  assert.equal(new Set(watched.counts).size, 1, watched.counts.join(","));
});

interface PoolAnswer {
  status: number;
  type: string | undefined;
  text: string;
  json: {
    state: string;
    reason: string | null;
    accounts: {
      name: string;
      held: boolean;
      heldUntil: number | null;
      buckets: { bucket: string; utilization: number; expires: number }[];
    }[];
  };
}

function requestPool(adminSocket: string, method = "GET"): Promise<PoolAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: adminSocket, path: "/pool", method, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"],
            text,
            json: (text === "" ? null : JSON.parse(text)) as PoolAnswer["json"],
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

const poolStates: [string, PoolSpec, string, string | null][] = [
  ["unset", "unset", "unconfigured", null],
  ["missing", "missing", "unconfigured", null],
  [
    "invalid",
    { alpha: "sk-wrong-made-up-alpha-token" },
    "unusable",
    "account alpha must hold a token that starts with sk-ant-oat",
  ],
  ["empty", {}, "unconfigured", null],
  ["valid", bothAccounts, "usable", null],
];

for (const [name, pool, state, reason] of poolStates) {
  test(`GET /pool answers ${state} with ${name} accounts, and no token`, async () => {
    const stub = await startModelStub();
    captureStderr();
    const { root } = await startGateway({
      models: { anthropic: stub.origin, pool },
    });
    const answer = await requestPool(path.join(root, "admin.sock"));
    assert.equal(answer.status, 200);
    assert.equal(answer.type, "application/json");
    assert.equal(answer.json.state, state);
    assert.equal(answer.json.reason, reason);
    assert.deepEqual(
      answer.json.accounts,
      state === "usable"
        ? [
            { name: "alpha", held: false, heldUntil: null, buckets: [] },
            { name: "bravo", held: false, heldUntil: null, buckets: [] },
          ]
        : [],
    );
    noSecrets(answer.text);
  });
}

test("the admin socket answers 404 to /pool with another method, and /sync is as before", async () => {
  const stub = await startModelStub();
  const { root } = await startGateway({ models: { anthropic: stub.origin } });
  const adminSocket = path.join(root, "admin.sock");
  assert.equal((await requestPool(adminSocket, "POST")).status, 404);
  assert.equal((await requestPool(adminSocket, "DELETE")).status, 404);
  assert.equal(await requestSync(adminSocket), 200);
});

test("GET /pool shows a utilization reading and a hold that a pooled response caused, and no token", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  let rejecting = false;
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response
        .writeHead(
          rejecting ? 429 : 200,
          rejecting
            ? [
                "content-type",
                "application/json",
                "anthropic-ratelimit-unified-status",
                "rejected",
                "anthropic-ratelimit-unified-reset",
                String(reset),
              ]
            : [
                "content-type",
                "application/json",
                "anthropic-ratelimit-unified-5h-utilization",
                "0.25",
                "anthropic-ratelimit-unified-5h-reset",
                String(reset),
              ],
        )
        .end("{}");
    });
  });
  captureStderr();
  const { root, socket } = await startGateway({
    models: { anthropic: stub.origin, pool: { alpha: tokens.alpha } },
  });
  const adminSocket = path.join(root, "admin.sock");
  const post = async (): Promise<ModelReply> =>
    claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal((await post()).status, 200);
  const reading = await requestPool(adminSocket);
  assert.deepEqual(reading.json.accounts, [
    {
      name: "alpha",
      held: false,
      heldUntil: null,
      buckets: [{ bucket: "5h", utilization: 0.25, expires: reset * 1000 }],
    },
  ]);
  rejecting = true;
  assert.equal((await post()).status, 429);
  const held = await requestPool(adminSocket);
  const [account] = held.json.accounts;
  assert.ok(account);
  assert.equal(account.held, true);
  assert.equal(account.heldUntil, reset * 1000);
  noSecrets(reading.text, held.text);
});

test("GET /pool changes only after /sync, keeping the readings of an account that is unchanged", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const stub = await startModelStub((_request, response, entry) => {
    void entry.ended.then(() => {
      response
        .writeHead(200, [
          "content-type",
          "application/json",
          "anthropic-ratelimit-unified-5h-utilization",
          "0.5",
          "anthropic-ratelimit-unified-5h-reset",
          String(reset),
        ])
        .end("{}");
    });
  });
  captureStderr();
  const { root, poolDirectory, socket } = await startGateway({
    models: { anthropic: stub.origin, pool: { alpha: tokens.alpha } },
  });
  const adminSocket = path.join(root, "admin.sock");
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  writeFileSync(path.join(poolDirectory, "bravo"), tokens.bravo, {
    mode: 0o600,
  });
  const before = await requestPool(adminSocket);
  assert.deepEqual(
    before.json.accounts.map(({ name }) => name),
    ["alpha"],
  );
  assert.equal(await requestSync(adminSocket), 200);
  const added = await requestPool(adminSocket);
  assert.deepEqual(
    added.json.accounts.map(({ name, buckets }) => [name, buckets.length]),
    [
      ["alpha", 1],
      ["bravo", 0],
    ],
  );
  rmSync(path.join(poolDirectory, "alpha"));
  rmSync(path.join(poolDirectory, "bravo"));
  assert.equal(await requestSync(adminSocket), 200);
  const emptied = await requestPool(adminSocket);
  assert.equal(emptied.json.state, "unconfigured");
  assert.equal(emptied.json.reason, null);
  assert.deepEqual(emptied.json.accounts, []);
  noSecrets(before.text, added.text, emptied.text);
});

const fireworksName = "api.fireworks.ai";
const keys = {
  one: "fw-made-up-one",
  two: "fw-made-up-two",
} as const;

function fireworks(
  socket: string,
  method: string,
  target: string,
  headers: Record<string, string | string[]> = {},
  body?: Buffer | string,
): Promise<ModelReply> {
  return modelClient(
    socket,
    method,
    target,
    { host: fireworksName, ...headers },
    body,
  ).response;
}

function keyFile(content: string | Buffer | null): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-key-"));
  defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "FIREWORKS_API_KEY");
  if (content !== null) {
    writeFileSync(file, content);
  }
  return file;
}

async function startFireworks(
  content: string | Buffer | null,
  respond?: Parameters<typeof startModelStub>[0],
  pool?: PoolSpec,
): Promise<
  Awaited<ReturnType<typeof startGateway>> & {
    file: string;
    provider: ModelStub;
    anthropic: ModelStub;
  }
> {
  const provider = await startModelStub(respond);
  const anthropic = await startModelStub();
  const file = keyFile(content);
  const started = await startGateway({
    models: {
      anthropic: anthropic.origin,
      fireworks: provider.origin,
      fireworksKeyFile: file,
      pool: pool ?? { alpha: tokens.alpha },
    },
  });
  return { ...started, file, provider, anthropic };
}

function noKeys(...shown: unknown[]): void {
  noSecrets(...shown);
  const text = JSON.stringify(shown);
  for (const key of Object.values(keys)) {
    assert.ok(!text.includes(key), "a key is shown");
  }
}

const unavailable = "the Fireworks key is not usable on the Mac";

test("a Fireworks request with the placeholder reaches Fireworks with the key in the Authorization line's place and spelling, and the rest of the list as sent", async () => {
  const { socket, instance, state, provider, anthropic } = await startFireworks(
    ` ${keys.one}\r\n`,
  );
  const stderr = captureStderr();
  const audit = recordFinishes(state);
  const reply = await exchange(
    socket,
    fireworksName,
    "POST /inference/v1/messages?beta=true HTTP/1.1\r\n" +
      "Host: api.fireworks.ai\r\n" +
      "X-Dup: one\r\n" +
      "aUtHoRiZaTiOn: Bearer cog\r\n" +
      "x-dup: two\r\n" +
      "Cookie: session=guest\r\n" +
      "User-Agent: claude-cli/2.1 (external, cli)\r\n" +
      "Connection: close, TE\r\n" +
      "TE: trailers\r\n" +
      "Content-Length: 2\r\n" +
      "X-Same: 1\r\n" +
      "X-Same: 2\r\n\r\n{}",
  );
  assert.equal(statusOf(reply), 200);
  assert.equal(anthropic.requests.length, 0);
  const [seen] = provider.requests;
  assert.ok(seen);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/inference/v1/messages?beta=true");
  assert.deepEqual(pairsOf(seen.rawHeaders), [
    "Host: api.fireworks.ai",
    "X-Dup: one",
    `aUtHoRiZaTiOn: Bearer ${keys.one}`,
    "x-dup: two",
    "Cookie: session=guest",
    "User-Agent: claude-cli/2.1 (external, cli)",
    "Content-Length: 2",
    "X-Same: 1",
    "X-Same: 2",
    "Connection: keep-alive",
  ]);
  assert.equal(seen.body.toString(), "{}");
  await within("the audit row", audit.first);
  const [row, ...others] = state.logs(instance.id);
  assert.deepEqual(others, []);
  assert.equal(row?.operation, "model.fireworks");
  assert.equal(row.repository, null);
  assert.equal(row.allowed, true);
  assert.equal(row.reason, "fireworks key");
  assert.equal(row.outcome, "completed");
  assert.equal(row.upstreamStatus, 200);
  noKeys(state.logs(instance.id), stderr, reply);
  assert.deepEqual(stderr, []);
});

test("a Fireworks request with no Authorization is forwarded as sent, whether or not the key file exists", async () => {
  for (const content of [keys.one, null]) {
    const { socket, instance, state, provider } = await startFireworks(content);
    const audit = recordFinishes(state);
    const reply = await fireworks(socket, "HEAD", "/inference/api/hello", {
      "X-Dup": ["one", "two"],
      Cookie: "session=guest",
    });
    assert.equal(reply.status, 200);
    const [seen] = provider.requests;
    assert.ok(seen);
    assert.equal(seen.url, "/inference/api/hello");
    assert.deepEqual(headerValues(seen.rawHeaders, "authorization"), []);
    assert.deepEqual(headerValues(seen.rawHeaders, "x-dup"), ["one", "two"]);
    await within("the audit row", audit.first);
    const [row, ...others] = state.logs(instance.id);
    assert.deepEqual(others, []);
    assert.equal(row?.operation, "model.fireworks");
    assert.equal(row.allowed, true);
    assert.equal(row.reason, "no credential");
  }
});

test("Fireworks targets reach the provider as written", async () => {
  const { socket, provider } = await startFireworks(keys.one);
  const targets = [
    "/inference/v1/messages?beta=true",
    "/inference/api/hello",
    "//x",
    "/inference/p%2fq/%7e?a={b}&c=%zz",
  ];
  for (const target of targets) {
    for (const headers of [poolHeaders, {}]) {
      assert.equal(
        (await fireworks(socket, "POST", target, headers, "{}")).status,
        200,
        target,
      );
    }
  }
  assert.deepEqual(
    provider.requests.map(({ url }) => url),
    targets.flatMap((target) => [target, target]),
  );
});

test("a Fireworks event stream, its status and its reason phrase reach the client as they come", async () => {
  const release = signal();
  const { socket, provider } = await startFireworks(
    keys.one,
    (_request, response, entry) => {
      void entry.ended.then(async () => {
        response.writeHead(207, "Partly Fine", {
          "content-type": "text/event-stream",
          "x-fireworks-note": "kept",
        });
        response.write("data: 1\n\n");
        await release.promise;
        response.end("data: 2\n\n");
      });
    },
  );
  const client = modelClient(
    socket,
    "POST",
    "/inference/v1/messages",
    { host: fireworksName, ...poolHeaders },
    "{}",
  );
  await within("the first event", client.firstData);
  release.resolve();
  const reply = await client.response;
  assert.equal(reply.status, 207);
  assert.equal(reply.statusMessage, "Partly Fine");
  assert.equal(reply.headers["x-fireworks-note"], "kept");
  assert.equal(reply.body.toString(), "data: 1\n\ndata: 2\n\n");
  assert.equal(provider.requests.length, 1);
});

test("Fireworks requests that break the rules are refused before anything is forwarded", async () => {
  const stderr = captureStderr();
  const { socket, instance, state, provider, anthropic } = await startFireworks(
    keys.one,
  );
  const target = "/inference/v1/messages";
  const requests: [string, Record<string, string | string[]>][] = [
    ["POST", { ...poolHeaders, "x-api-key": "k" }],
    ["POST", { "x-api-key": "k" }],
    ["POST", { authorization: "Bearer guest" }],
    ["POST", { authorization: `Bearer ${keys.one}` }],
    ["POST", { authorization: "bearer cog" }],
    ["POST", { authorization: ["Bearer cog", "Bearer cog"] }],
    ["POST", { ...poolHeaders, connection: "host" }],
    ["POST", { ...poolHeaders, connection: "authorization" }],
    ["TRACE", poolHeaders],
  ];
  for (const [method, headers] of requests) {
    const reply = await fireworks(socket, method, target, headers, "{}");
    assert.equal(reply.status, 403, JSON.stringify(headers));
    assert.equal(reply.headers["x-should-retry"], "false");
    assert.equal(claudeError(reply).type, "permission_error");
    noKeys(reply.body.toString());
  }
  const raw = [
    rawRequest(
      "POST",
      "http://api.fireworks.ai/x",
      fireworksName,
      "content-length: 0",
    ),
    rawRequest("POST", "*", fireworksName, "content-length: 0"),
    rawRequest(
      "GET",
      "/x",
      fireworksName,
      "transfer-encoding: chunked",
      "0\r\n\r\n",
    ),
    rawRequest(
      "POST",
      "/x",
      fireworksName,
      "host: api.fireworks.ai\r\ncontent-length: 2",
      "{}",
    ),
    rawRequest(
      "POST",
      "/x",
      fireworksName,
      "authorization: Bearer cog\r\ncontent-length: 2\r\ncontent-length: 2",
      "{}",
    ),
    rawRequest(
      "POST",
      "/x",
      fireworksName,
      "authorization: Bearer cog\r\ncontent-length: 2\r\ntransfer-encoding: chunked",
      "{}",
    ),
  ];
  for (const request of raw) {
    const reply = await exchange(socket, fireworksName, request);
    assert.ok([400, 403].includes(statusOf(reply)), request);
  }
  assert.equal(provider.requests.length, 0);
  assert.equal(anthropic.requests.length, 0);
  const rows = state.logs(instance.id);
  assert.ok(rows.length >= requests.length);
  for (const row of rows) {
    assert.equal(row.allowed, false);
    assert.equal(row.operation, "model.fireworks");
    assert.equal(row.outcome, "denied");
  }
  noKeys(rows, stderr);
});

test("the Fireworks health path is answered locally whatever the key file holds", async () => {
  for (const content of [keys.one, null, "two words"]) {
    captureStderr();
    const { socket, instance, state, provider } = await startFireworks(content);
    const audit = recordFinishes(state);
    const reply = await fireworks(socket, "GET", "/__cog__/health");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), "cog ready\n");
    await within("the audit row", audit.first);
    assert.equal(provider.requests.length, 0);
    const [row, ...others] = state.logs(instance.id);
    assert.deepEqual(others, []);
    assert.equal(row?.operation, "public.read");
    assert.equal(row.reason, "anonymous read");
  }
});

test("the key file is read for each credentialed request, and a missing file stops only those, silently", async () => {
  const stderr = captureStderr();
  const { socket, file, provider, instance, state } = await startFireworks(
    `${keys.one}\n`,
  );
  const post = (headers: Record<string, string>): Promise<ModelReply> =>
    fireworks(socket, "POST", "/inference/v1/messages", headers, "{}");
  assert.equal((await post(poolHeaders)).status, 200);
  writeFileSync(file, `${keys.two}\n`);
  assert.equal((await post(poolHeaders)).status, 200);
  rmSync(file);
  const gone = await post(poolHeaders);
  assert.equal(gone.status, 503);
  assert.deepEqual(claudeError(gone), {
    type: "api_error",
    message: `cog gateway: ${unavailable}`,
  });
  assert.equal((await post({})).status, 200);
  writeFileSync(file, `${keys.one}\n`);
  assert.equal((await post(poolHeaders)).status, 200);
  assert.deepEqual(
    provider.requests.map((entry) => entry.headers.authorization),
    [
      `Bearer ${keys.one}`,
      `Bearer ${keys.two}`,
      undefined,
      `Bearer ${keys.one}`,
    ],
  );
  assert.deepEqual(stderr, []);
  const rows = state.logs(instance.id);
  assert.deepEqual(
    rows.map(({ allowed, reason }) => [allowed, reason]).toReversed(),
    [
      [true, "fireworks key"],
      [true, "fireworks key"],
      [false, unavailable],
      [true, "no credential"],
      [true, "fireworks key"],
    ],
  );
  noKeys(rows, stderr);
});

test("a key file that breaks the reading rule makes credentialed Fireworks requests 503, names no content, and leaves other requests alone", async () => {
  const bad: [string, string | Buffer][] = [
    ["an empty file", ""],
    ["only whitespace", " \r\n\t\n"],
    ["two words", `${keys.one} ${keys.two}`],
    ["two lines", `${keys.one}\n${keys.two}\n`],
    ["a tab inside", `${keys.one}\t${keys.two}`],
    ["a vertical tab inside", `${keys.one}\v${keys.two}`],
    ["a control character", `${keys.one}\u{1}`],
    ["a NUL", `${keys.one}\0`],
    ["a DEL", `${keys.one}\u{7F}`],
    ["a non-ASCII byte", Buffer.from([...Buffer.from(keys.one), 0xe9])],
    ["a UTF-8 character", `${keys.one}é`],
    ["too many bytes", `${"k".repeat(4096)}\n`],
    ["too much padding", `${keys.one}${" ".repeat(4100)}`],
  ];
  for (const [what, content] of bad) {
    const stderr = captureStderr();
    const { socket, provider, instance, state } = await startFireworks(content);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await fireworks(
        socket,
        "POST",
        "/inference/v1/messages",
        poolHeaders,
        "{}",
      );
      assert.equal(reply.status, 503, what);
      assert.deepEqual(claudeError(reply), {
        type: "api_error",
        message: `cog gateway: ${unavailable}`,
      });
    }
    assert.equal(provider.requests.length, 0, what);
    assert.equal(stderr.length, 1, what);
    assert.match(
      stderr[0] ?? "",
      /^cog: Fireworks key file .*FIREWORKS_API_KEY .+\n$/,
    );
    for (const row of state.logs(instance.id)) {
      assert.equal(row.allowed, false);
      assert.equal(row.operation, "model.fireworks");
      assert.equal(row.reason, unavailable);
    }
    noKeys(state.logs(instance.id), stderr);
    assert.equal(
      (await fireworks(socket, "GET", "/inference/api/hello")).status,
      200,
    );
    mock.restore();
  }
});

test("a key file that is a directory or a named pipe makes credentialed requests 503 without waiting for it", async () => {
  captureStderr();
  const directory = mkdtempSync(path.join(tmpdir(), "cog-key-"));
  defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(path.join(directory, "folder"));
  const pipe = path.join(directory, "pipe");
  assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
  for (const file of [path.join(directory, "folder"), pipe]) {
    const provider = await startModelStub();
    const { socket } = await startGateway({
      models: { fireworks: provider.origin, fireworksKeyFile: file },
    });
    const reply = await fireworks(
      socket,
      "POST",
      "/inference/v1/messages",
      poolHeaders,
      "{}",
    );
    assert.equal(reply.status, 503, file);
    assert.equal(provider.requests.length, 0);
  }
});

test("a key file that follows the reading rule is used", async () => {
  const punctuation = "!\"#$%&'()*+,-./:;<=>?@[]^_`{|}~";
  const good: [string, string, string][] = [
    ["a trailing newline", `${keys.one}\n`, keys.one],
    ["carriage returns", `\r\n ${keys.one} \r\n`, keys.one],
    ["a carriage return inside", "fw-made\r-up", "fw-made-up"],
    ["the byte limit", `${"k".repeat(4095)}\n`, "k".repeat(4095)],
    ["visible punctuation", punctuation, punctuation],
  ];
  for (const [what, content, expected] of good) {
    const { socket, provider } = await startFireworks(content);
    const reply = await fireworks(
      socket,
      "POST",
      "/inference/v1/messages",
      poolHeaders,
      "{}",
    );
    assert.equal(reply.status, 200, what);
    assert.equal(
      provider.requests[0]?.headers.authorization,
      `Bearer ${expected}`,
      what,
    );
  }
  const provider = await startModelStub();
  const file = keyFile(null);
  const real = `${file}.real`;
  writeFileSync(real, `${keys.two}\n`);
  symlinkSync(real, file);
  const { socket } = await startGateway({
    models: { fireworks: provider.origin, fireworksKeyFile: file },
  });
  await fireworks(socket, "POST", "/inference/v1/messages", poolHeaders, "{}");
  assert.equal(
    provider.requests[0]?.headers.authorization,
    `Bearer ${keys.two}`,
  );
});

test("the stderr line is written once per changed reason, and never for a missing file, a dangling link or an option that was not given", async () => {
  const stderr = captureStderr();
  const { socket, file } = await startFireworks(null);
  const credentialed = async (): Promise<number> =>
    (
      await fireworks(
        socket,
        "POST",
        "/inference/v1/messages",
        poolHeaders,
        "{}",
      )
    ).status;
  assert.equal(await credentialed(), 503);
  symlinkSync(`${file}.nowhere`, file);
  assert.equal(await credentialed(), 503);
  rmSync(file);
  assert.deepEqual(stderr, []);
  writeFileSync(file, "");
  await credentialed();
  await credentialed();
  assert.equal(stderr.length, 1);
  writeFileSync(file, "a b");
  await credentialed();
  assert.equal(stderr.length, 2);
  assert.notEqual(stderr[0], stderr[1]);
  writeFileSync(file, keys.one);
  assert.equal(await credentialed(), 200);
  writeFileSync(file, "a b");
  await credentialed();
  assert.equal(stderr.length, 3);
  assert.equal(stderr[2], stderr[1]);
  noKeys(stderr);

  const quiet = captureStderr();
  const provider = await startModelStub();
  const unset = await startGateway({ models: { fireworks: provider.origin } });
  const reply = await fireworks(
    unset.socket,
    "POST",
    "/inference/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(reply.status, 503);
  assert.deepEqual(quiet, []);
  assert.equal(provider.requests.length, 0);
});

test("a Fireworks fault does not touch Claude, and a Claude pool fault does not touch Fireworks", async () => {
  captureStderr();
  const broken = await startFireworks("two words");
  assert.equal(
    (
      await fireworks(
        broken.socket,
        "POST",
        "/inference/v1/messages",
        poolHeaders,
        "{}",
      )
    ).status,
    503,
  );
  const claudeReply = await claude(
    broken.socket,
    "POST",
    "/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(claudeReply.status, 200);
  assert.equal(broken.anthropic.requests.length, 1);
  assert.equal(
    broken.anthropic.requests[0]?.headers.authorization,
    `Bearer ${accountToken}`,
  );
  const fine = await startFireworks(keys.one, undefined, "missing");
  assert.equal(
    (await claude(fine.socket, "POST", "/v1/messages", poolHeaders, "{}"))
      .status,
    503,
  );
  const reply = await fireworks(
    fine.socket,
    "POST",
    "/inference/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(reply.status, 200);
  assert.equal(
    fine.provider.requests[0]?.headers.authorization,
    `Bearer ${keys.one}`,
  );
});

test("a placeholder request never gets the other host's credential or reaches the other host's upstream, whatever its SNI", async () => {
  const { socket, provider, anthropic } = await startFireworks(keys.one);
  for (const servername of [claudeName, fireworksName]) {
    for (const [host, target] of [
      [fireworksName, "/v1/messages"],
      [claudeName, "/inference/v1/messages"],
    ] as const) {
      const request = https.request({
        socketPath: socket,
        servername,
        rejectUnauthorized: false,
        method: "POST",
        path: target,
        agent: false,
        headers: { host, ...poolHeaders },
      });
      defer(() => {
        request.destroy();
      });
      const answered = once(request, "response");
      request.end("{}");
      const [response] = (await within("the answer", answered)) as [
        IncomingMessage,
      ];
      response.resume();
      assert.equal(response.statusCode, 200);
    }
  }
  assert.equal(provider.requests.length, 2);
  assert.equal(anthropic.requests.length, 2);
  for (const entry of provider.requests) {
    assert.deepEqual(headerValues(entry.rawHeaders, "host"), [fireworksName]);
    assert.equal(entry.headers.authorization, `Bearer ${keys.one}`);
  }
  for (const entry of anthropic.requests) {
    assert.deepEqual(headerValues(entry.rawHeaders, "host"), [claudeName]);
    assert.equal(entry.headers.authorization, `Bearer ${accountToken}`);
  }
  for (const host of [
    "api.fireworks.ai:443",
    "api.fireworks.ai.",
    "fireworks.ai",
  ]) {
    const reply = await fireworks(
      socket,
      "POST",
      "/x",
      { host, ...poolHeaders },
      "{}",
    );
    assert.equal(reply.status, 403, host);
  }
  assert.equal(provider.requests.length, 2);
  assert.equal(anthropic.requests.length, 2);
});

test("Fireworks responses are not read for rate limits, so the pool's choice is unchanged", async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const { socket, anthropic, instance } = await startFireworks(
    keys.one,
    (_request, response, entry) => {
      void entry.ended.then(() => {
        response
          .writeHead(429, {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": reset,
          })
          .end("{}");
      });
    },
    bothAccounts,
  );
  const reply = await fireworks(
    socket,
    "POST",
    "/inference/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(reply.status, 429);
  await claude(socket, "POST", "/v1/messages", poolHeaders, "{}");
  assert.equal(tokenSeen(lastRequest(anthropic)), firstAccount(instance.id));
});

test("a Fireworks upstream that fails is a retryable 503 and a gateway-error row, with no key reported", async () => {
  const stderr = captureStderr();
  const { socket, instance, state } = await startFireworks(
    keys.one,
    (request, _response, entry) => {
      void entry.ended.then(() => {
        request.socket.destroy();
      });
    },
  );
  const reply = await fireworks(
    socket,
    "POST",
    "/inference/v1/messages",
    poolHeaders,
    "{}",
  );
  assert.equal(reply.status, 503);
  assert.equal(reply.headers["x-should-retry"], undefined);
  assert.deepEqual(
    state.logs(instance.id).map(({ outcome, operation }) => ({
      outcome,
      operation,
    })),
    [{ outcome: "gateway-error", operation: "model.fireworks" }],
  );
  noKeys(state.logs(instance.id), stderr, reply.body.toString());
});

test("Fireworks requests use the 600 s timeout, a safe body-less one is replayed once on a stale connection, and a VM's one agent serves both hosts but no other VM", async () => {
  const requested = spyOn(http, "request");
  let reused = 0;
  const { socket, provider, anthropic, state, gateway } = await startFireworks(
    keys.one,
    (request, response, entry) => {
      if (
        entry.connection === 1 &&
        provider.requests.filter((other) => other.connection === 1).length > 1
      ) {
        reused += 1;
        request.socket.destroy();
        return;
      }
      replyOk(request, response, entry);
    },
  );
  assert.equal(
    (
      await fireworks(
        socket,
        "POST",
        "/inference/v1/messages",
        poolHeaders,
        "{}",
      )
    ).status,
    200,
  );
  assert.equal(
    (await fireworks(socket, "GET", "/inference/v1/models", poolHeaders))
      .status,
    200,
  );
  assert.equal(reused, 1);
  assert.deepEqual(
    provider.requests.map(({ method, connection }) => [method, connection]),
    [
      ["POST", 1],
      ["GET", 1],
      ["GET", 2],
    ],
  );
  assert.equal(
    provider.requests[2]?.headers.authorization,
    `Bearer ${keys.one}`,
  );
  assert.equal(
    (await claude(socket, "POST", "/v1/messages", poolHeaders, "{}")).status,
    200,
  );
  assert.equal(anthropic.connections.length, 1);
  const calls = requested.mock.calls.map(([target, options]) => ({
    origin: String(target instanceof URL ? target.origin : target),
    timeout: (options as http.RequestOptions | undefined)?.timeout,
    agent: (options as http.RequestOptions | undefined)?.agent,
  }));
  assert.deepEqual(
    calls.map(({ origin, timeout }) => [origin, timeout]),
    [
      [provider.origin, 600_000],
      [provider.origin, 600_000],
      [provider.origin, 600_000],
      [anthropic.origin, 600_000],
    ],
  );
  const agents = new Set(calls.map(({ agent }) => agent));
  assert.equal(agents.size, 1);
  const other = state.register(
    "lima:other",
    path.join(path.dirname(socket), "other.sock"),
    "tester",
  );
  await gateway.refresh();
  assert.equal(
    (
      await fireworks(
        other.socket,
        "POST",
        "/inference/v1/messages",
        poolHeaders,
        "{}",
      )
    ).status,
    200,
  );
  assert.deepEqual(provider.connections.length, 3);
  assert.equal(provider.requests.at(-1)?.connection, 3);
});

test("an http upstream for one model host and a TLS upstream for the other are each reached from one VM, in either order", async () => {
  const secure: string[] = [];
  const upstream = https.createServer(
    { cert: readFileSync(certificate), key: readFileSync(key) },
    (request, response) => {
      secure.push(request.url ?? "");
      request.resume();
      response.writeHead(200, { "content-length": "2" }).end("ok");
    },
  );
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  defer(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => {
      upstream.close(() => {
        resolve();
      });
    });
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const NativeAgent = https.Agent;
  const mutable = https as { Agent: unknown };
  mutable.Agent = class extends NativeAgent {
    constructor(options?: https.AgentOptions) {
      super({
        ...options,
        ca: readFileSync(certificate),
        checkServerIdentity: () => {
          return;
        },
      });
    }
  };
  defer(() => {
    mutable.Agent = NativeAgent;
  });
  const plain = await startModelStub();
  const { socket, state, gateway } = await startGateway({
    models: {
      anthropic: plain.origin,
      fireworks: `https://127.0.0.1:${String(address.port)}`,
    },
  });
  const other = state.register(
    "lima:other",
    path.join(path.dirname(socket), "other.sock"),
    "tester",
  );
  await gateway.refresh();
  const reach = async (vm: string, host: "claude" | "fireworks") =>
    host === "claude"
      ? claude(vm, "POST", "/v1/messages", {}, "{}")
      : fireworks(vm, "POST", "/inference/v1/messages", {}, "{}");
  for (const [vm, order] of [
    [socket, ["claude", "fireworks"]],
    [other.socket, ["fireworks", "claude"]],
  ] as const) {
    for (const host of order) {
      assert.equal((await reach(vm, host)).status, 200, host);
    }
  }
  assert.deepEqual(
    plain.requests.map(({ url }) => url),
    ["/v1/messages", "/v1/messages"],
  );
  assert.deepEqual(secure, [
    "/inference/v1/messages",
    "/inference/v1/messages",
  ]);
});
