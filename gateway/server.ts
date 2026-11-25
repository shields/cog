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

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { AppAuth } from "./auth.ts";
import {
  classifyModel,
  hasNoBody,
  isReplayable,
  modelHostFor,
  modelRefusal,
  modelRequestHeaders,
  modelResponseHeaders,
  needsExplicitLength,
  type ModelHost,
} from "./models.ts";
import { readKeyFile } from "./key-file.ts";
import {
  authorize,
  classify,
  denial,
  inspectedBody,
  isBlockedResponseHeader,
  isHealthCheck,
  PolicyError,
  requireIdentityEncoding,
  requireNoGetOrHeadBody,
  rewriteLinks,
  PushDenied,
  PushParser,
  type Classification,
} from "./policy.ts";
import {
  AccountPool,
  loadPool,
  unconfiguredReason,
  type Account,
  type AccountSnapshot,
} from "./pool.ts";
import { State } from "./state.ts";

interface RequestBody {
  buffered: Buffer;
  remaining: AsyncIterator<Buffer>;
}

interface Settlement {
  upstreamStatus: number | null;
  outcome: "completed" | "interrupted";
}

export interface GatewayOptions {
  cert: string;
  key: string;
  adminSocket: string;
  webUpstream?: string;
  apiUpstream?: string;
  pool?: string;
  anthropicUpstream?: string;
  fireworksUpstream?: string;
  fireworksKeyFile?: string;
  upstreamIdleTimeout?: number;
}

interface ModelCredential {
  token: string;
  reason: string;
  account: Account | null;
}

const fireworksUnusable = "the Fireworks key is not usable on the Mac";

// A socket that the network dropped while the Mac slept is otherwise reused by
// the next request, which cannot be sent again when it has a body. A request
// sets its own timeout once it has a socket.
const upstreamIdleTimeout = 30_000;

const drainTimeout = 60_000;

const forwardedHeaders = [
  "accept",
  "content-type",
  "user-agent",
  "git-protocol",
  "if-none-match",
  "range",
  "x-github-api-version",
  "content-length",
] as const;

const reasonPhrase = /^[\t\u{20}-\u{7E}]*$/u;

class ModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ModelUnavailable";
  }
}

function bodyIterator(request: IncomingMessage): AsyncIterator<Buffer> {
  return request[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
}

// A connection that failed on every address of a host is an AggregateError
// whose message is empty, so the failures it holds are listed.
function describeFailure(error: unknown): string {
  return error instanceof AggregateError
    ? `${String(error)}: ${error.errors.map(String).join("; ")}`
    : String(error);
}

export async function readBody(
  remaining: AsyncIterator<Buffer>,
  contentEncoding: string | undefined,
  limit: number,
  pushInstanceId?: string,
): Promise<RequestBody> {
  requireIdentityEncoding(contentEncoding);
  const parser =
    pushInstanceId === undefined ? null : new PushParser(pushInstanceId);
  let storage = Buffer.alloc(0);
  let length = 0;
  for (;;) {
    const next = await remaining.next();
    if (next.done) {
      return { buffered: storage.subarray(0, length), remaining };
    }
    if (length + next.value.length > storage.length) {
      const grown = Buffer.allocUnsafe(
        Math.max(length + next.value.length, storage.length * 2),
      );
      storage.copy(grown, 0, 0, length);
      storage = grown;
    }
    next.value.copy(storage, length);
    length += next.value.length;
    const buffered = storage.subarray(0, length);
    if (parser !== null && parser.parse(buffered) !== null) {
      return { buffered, remaining };
    }
    if (length > limit) {
      throw new PolicyError("request prefix is too large");
    }
  }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function drained(
  remaining: AsyncIterator<Buffer>,
  limit: number,
): Promise<boolean> {
  let length = 0;
  for (;;) {
    const next = await remaining.next();
    if (next.done) {
      return true;
    }
    length += next.value.length;
    if (length > limit) {
      return false;
    }
  }
}

// Bun emits no "drain" on a request once the response to it has ended, so a
// write that is waiting for one at that point waits for ever. Its wait
// resolves false instead. A promise keeps each reaction added to it until it
// settles, so every wait of a body shares the one reaction on upstreamDone: a
// reaction for each wait would hold its closure and the request until the
// upstream closes. Bun emits no "timeout" for a request whose upload the
// upstream has stopped reading, and does not report a guest that leaves while
// its upload is not being read, so a wait that outlasts limit fails.
function drainWaiter(
  upstream: http.ClientRequest,
  upstreamDone: Promise<undefined>,
  limit: number,
): () => Promise<boolean> {
  let done = false;
  let release: (() => void) | null = null;
  void upstreamDone.then(() => {
    done = true;
    release?.();
  });
  return () =>
    done
      ? Promise.resolve(false)
      : new Promise<boolean>((resolve, reject) => {
          const end = (): void => {
            release = null;
            clearTimeout(stalled);
            upstream.off("drain", onDrain);
            upstream.off("error", onError);
          };
          const onDrain = (): void => {
            end();
            resolve(true);
          };
          const onError = (error: Error): void => {
            end();
            reject(error);
          };
          const stalled = setTimeout(() => {
            onError(new Error("upstream stopped reading the request body"));
          }, limit);
          release = (): void => {
            end();
            resolve(false);
          };
          upstream.once("drain", onDrain);
          upstream.once("error", onError);
        });
}

// False once the upstream has answered or gone and does not take the chunk. It
// is cut off then, and the rest of the upload is read and dropped, so that the
// guest's connection carries its next request.
async function send(
  upstream: http.ClientRequest,
  chunk: Buffer,
  flushed: () => Promise<boolean>,
): Promise<boolean> {
  if (upstream.write(chunk) || (await flushed())) {
    return true;
  }
  upstream.destroy();
  return false;
}

export async function sendBody(
  upstream: http.ClientRequest,
  body: RequestBody,
  upstreamDone: Promise<undefined>,
  limit = drainTimeout,
): Promise<void> {
  const flushed = drainWaiter(upstream, upstreamDone, limit);
  let sending = true;
  if (body.buffered.length > 0) {
    sending = await send(upstream, body.buffered, flushed);
  }
  for (;;) {
    const next = await body.remaining.next();
    if (next.done) {
      break;
    }
    if (sending) {
      sending = await send(upstream, next.value, flushed);
    }
  }
  if (sending) {
    upstream.end();
  }
}

function requestHeaders(
  headers: IncomingHttpHeaders,
  token: string | null,
  host: string,
  forwardEncoding: boolean,
): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = { host };
  for (const name of forwardedHeaders) {
    const value = headers[name];
    if (typeof value === "string") {
      outgoing[name] = value;
    }
  }
  if (forwardEncoding && headers["content-encoding"] !== undefined) {
    outgoing["content-encoding"] = headers["content-encoding"];
  }
  if (token) {
    outgoing.authorization =
      host === "github.com"
        ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
        : `Bearer ${token}`;
  }
  return outgoing;
}

function respondReady(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/plain" }).end("cog ready\n");
}

function headerNames(headers: http.OutgoingHttpHeaders | string[]): string[] {
  return Array.isArray(headers)
    ? headers.filter((_name, index) => index % 2 === 0)
    : Object.keys(headers);
}

function copyResponseHeaders(
  headers: IncomingHttpHeaders,
  classification: Classification,
): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isBlockedResponseHeader(name) && value !== undefined) {
      outgoing[name] =
        name === "link" && typeof value === "string"
          ? rewriteLinks(value, classification)
          : value;
    }
  }
  return outgoing;
}

export class Gateway {
  readonly state: State;
  readonly auth: AppAuth;
  readonly options: GatewayOptions;
  private readonly listeners = new Map<string, https.Server>();
  private admin: http.Server | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private readonly retired = new Map<https.Server, Promise<void>>();
  private readonly agents = new Map<string, http.Agent>();
  private pool: AccountPool | null = null;
  private lastPool: AccountPool | null = null;
  private poolReason: string | null = null;
  private fireworksReason: string | null = null;
  private stopped = false;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(state: State, auth: AppAuth, options: GatewayOptions) {
    this.state = state;
    this.auth = auth;
    this.options = options;
  }

  async start(): Promise<void> {
    this.requireRunning();
    if (this.starting) {
      throw new Error("gateway is already started");
    }
    this.starting = this.open();
    try {
      await this.starting;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async open(): Promise<void> {
    this.loadPool();
    await this.refresh();
    this.requireRunning();
    await this.startAdmin();
    this.requireRunning();
    this.refreshTimer = setInterval(() => {
      this.track(this.refreshAndPrune());
    }, 60_000);
  }

  private loadPool(): void {
    const loaded =
      this.options.pool === undefined
        ? { usable: false as const, reason: unconfiguredReason }
        : loadPool(this.options.pool);
    this.pool = loaded.usable
      ? new AccountPool(loaded.accounts, this.lastPool)
      : null;
    const reason = loaded.usable ? null : loaded.reason;
    // An operator who removed every account expects its tokens to be gone.
    if (this.pool !== null || reason === unconfiguredReason) {
      this.lastPool = this.pool;
    }
    if (
      reason !== null &&
      reason !== unconfiguredReason &&
      reason !== this.poolReason
    ) {
      process.stderr.write(`cog: Claude pool unavailable: ${reason}\n`);
    }
    this.poolReason = reason;
  }

  // stop() closes servers only once open() has settled, so open() fails at
  // the first step that finds the gateway stopped and leaves the closing to it.
  private requireRunning(): void {
    if (this.stopped) {
      throw new Error("gateway is stopped");
    }
  }

  private async refreshAndPrune(): Promise<void> {
    try {
      await this.refresh();
      this.state.prune();
    } catch (error) {
      process.stderr.write(`cog: listener refresh failed: ${String(error)}\n`);
      throw error;
    }
  }

  // The set holds the work itself. The promise that finally() returns stays
  // unobserved so that a failure of the work is reported as an unhandled
  // rejection; waiting on it in stop() would mark the failure as handled.
  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => {
      this.pending.delete(work);
    });
  }

  refresh(): Promise<void> {
    const next = (async () => {
      await Promise.allSettled([this.syncing]);
      await this.refreshNow();
    })();
    this.syncing = next;
    return next;
  }

  private async refreshNow(): Promise<void> {
    const active = new Map(
      this.state.active().map((instance) => [instance.id, instance]),
    );
    for (const [id, server] of this.listeners) {
      if (!active.has(id)) {
        const closed = closeServer(server);
        this.retired.set(server, closed);
        void closed.then(() => {
          this.retired.delete(server);
        });
        this.listeners.delete(id);
        this.destroyAgent(id);
      }
    }
    for (const instance of active.values()) {
      if (this.listeners.has(instance.id)) {
        continue;
      }
      if (this.stopped) {
        return;
      }
      if (existsSync(instance.socket)) {
        rmSync(instance.socket);
      }
      const server = https.createServer(
        {
          cert: readFileSync(this.options.cert),
          key: readFileSync(this.options.key),
          // requestTimeout covers a push's whole upload, and GitHub accepts
          // pushes up to 2 GiB: about an hour at 5 Mbit/s.
          requestTimeout: 3_600_000,
          headersTimeout: 60_000,
        },
        (request, response) => {
          // A connection that Bun hands over after the close has not been
          // swept, and would stay open until the keep-alive timeout.
          if (this.stopped) {
            response.setHeader("connection", "close");
          }
          this.track(this.handle(instance.id, request, response));
        },
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(instance.socket, () => {
          server.off("error", reject);
          server.on("error", (error) => {
            throw error;
          });
          resolve();
        });
      });
      this.listeners.set(instance.id, server);
    }
  }

  private async startAdmin(): Promise<void> {
    if (existsSync(this.options.adminSocket)) {
      rmSync(this.options.adminSocket);
    }
    this.admin = http.createServer((request, response) => {
      if (request.method === "POST" && request.url === "/sync") {
        this.track(this.sync(response));
      } else if (request.method === "GET" && request.url === "/health") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"ok":true}');
      } else if (request.method === "GET" && request.url === "/pool") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(this.poolStatus()));
      } else if (request.method === "GET" && request.url === "/fireworks-key") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(this.fireworksKeyStatus()));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.admin?.once("error", reject);
      this.admin?.listen(this.options.adminSocket, () => {
        this.admin?.off("error", reject);
        this.admin?.on("error", (error) => {
          throw error;
        });
        resolve();
      });
    });
  }

  private poolStatus(): {
    state: "unconfigured" | "unusable" | "usable";
    reason: string | null;
    accounts: AccountSnapshot[];
  } {
    if (this.pool !== null) {
      return {
        state: "usable",
        reason: null,
        accounts: this.pool.snapshot(Date.now()),
      };
    }
    return this.poolReason === unconfiguredReason
      ? { state: "unconfigured", reason: null, accounts: [] }
      : { state: "unusable", reason: this.poolReason, accounts: [] };
  }

  // A link to nothing is reported as unusable: the reader calls it missing,
  // and a request would fail on it.
  private fireworksKeyStatus(): {
    state: "missing" | "unusable" | "usable";
    reason: string | null;
  } {
    const file = this.options.fireworksKeyFile;
    if (file === undefined) {
      return { state: "missing", reason: null };
    }
    const result = readKeyFile(file);
    if (result.kind === "key") {
      return { state: "usable", reason: null };
    }
    if (result.kind === "unusable") {
      return { state: "unusable", reason: result.reason };
    }
    try {
      lstatSync(file);
    } catch {
      return { state: "missing", reason: null };
    }
    return { state: "unusable", reason: "is not a regular file" };
  }

  private async sync(response: ServerResponse): Promise<void> {
    try {
      this.loadPool();
      await this.refresh();
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"ok":true}');
    } catch (error) {
      process.stderr.write(`cog: listener sync failed: ${String(error)}\n`);
      response.writeHead(503).end();
    }
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // A refresh that is starting a server, and a start() that is opening the
    // admin server, add theirs before the servers to close are collected.
    await Promise.allSettled([this.starting, this.syncing]);
    const serving = [
      ...this.listeners.values(),
      ...(this.admin ? [this.admin] : []),
    ];
    const closes = [
      ...serving.map((server) => closeServer(server)),
      ...this.retired.values(),
    ];
    // A close completes only when every connection has ended. Connections
    // that were busy are idle once their handlers finish, and would otherwise
    // stay open until the keep-alive timeout. When nothing was busy, close()
    // has already swept the idle connections, and Bun resets a connection that
    // a second sweep finds still sending its last response.
    const busy = this.pending.size > 0;
    await this.awaitHandlers();
    if (busy) {
      for (const server of serving) {
        server.closeIdleConnections();
      }
    }
    // A retired server belongs to a disabled VM, whose requests are refused,
    // so the connections it still has are cut.
    for (const server of this.retired.keys()) {
      server.closeAllConnections();
    }
    await Promise.all(closes);
    this.listeners.clear();
    this.admin = null;
    await this.awaitHandlers();
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }

  private destroyAgent(instanceId: string): void {
    for (const scheme of ["http", "https"]) {
      const key = `${instanceId} ${scheme}`;
      this.agents.get(key)?.destroy();
      this.agents.delete(key);
    }
  }

  private agentFor(instanceId: string, secure: boolean): http.Agent {
    if (!this.listeners.has(instanceId)) {
      throw new Error("the VM's listener is closed");
    }
    // An agent has one scheme, so a VM has one for each scheme that its
    // upstreams use.
    const key = `${instanceId} ${secure ? "https" : "http"}`;
    let agent = this.agents.get(key);
    if (agent === undefined) {
      const options = {
        keepAlive: true,
        timeout: this.options.upstreamIdleTimeout ?? upstreamIdleTimeout,
      };
      agent = secure ? new https.Agent(options) : new http.Agent(options);
      this.agents.set(key, agent);
    }
    return agent;
  }

  private async awaitHandlers(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  private async handle(
    instanceId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    let classification: Classification | null = null;
    let modelHost = false;
    let revision = 0;
    let logged = false;
    let settlement: Settlement;
    const remaining = bodyIterator(request);
    try {
      revision = this.state.byId(instanceId)?.revision ?? 0;
      const host = request.headers.host?.toLowerCase();
      const target = request.url ?? "";
      const method = request.method ?? "";
      const model = modelHostFor(host);
      if (model !== undefined) {
        modelHost = true;
        classification = {
          repository: null,
          operation: model.operation,
          refs: [],
        };
        const route = classifyModel(method, target, request.rawHeaders);
        requireNoGetOrHeadBody(
          method,
          request.headers["transfer-encoding"],
          request.headers["content-length"],
        );
        const current = this.state.byId(instanceId);
        if (!current || current.disabled) {
          throw new PolicyError("VM access has been revoked");
        }
        revision = current.revision;
        const credential =
          route.kind === "forward" && route.route === "placeholder"
            ? this.credentialFor(model, instanceId)
            : null;
        if (route.kind === "health") {
          classification.operation = "public.read";
        }
        this.state.logDecision({
          id: requestId,
          instanceId,
          repository: null,
          operation: classification.operation,
          refs: [],
          allowed: true,
          reason:
            route.kind === "health"
              ? "anonymous read"
              : (credential?.reason ?? "no credential"),
          revision,
        });
        logged = true;
        if (route.kind === "health") {
          respondReady(response);
          settlement = { upstreamStatus: 200, outcome: "completed" };
        } else {
          settlement = await this.forwardModel(
            request,
            response,
            model,
            credential,
            instanceId,
            target,
            remaining,
          );
        }
      } else if (host === "github.com" || host === "api.github.com") {
        const inspected = inspectedBody(host, method, target);
        const body: RequestBody =
          inspected === null
            ? { buffered: Buffer.alloc(0), remaining }
            : await readBody(
                remaining,
                request.headers["content-encoding"],
                1_048_576,
                inspected === "push" ? instanceId : undefined,
              );
        classification = classify(
          {
            host,
            method,
            target,
            ...(inspected === null ? {} : { body: body.buffered }),
          },
          instanceId,
        );
        // Node writes the body of a GET or HEAD upstream without framing unless
        // the client gave a Content-Length, and GitHub would read it as the next
        // request on a connection that every VM shares.
        requireNoGetOrHeadBody(
          method,
          request.headers["transfer-encoding"],
          request.headers["content-length"],
        );
        const beforeRefresh = this.state.byId(instanceId);
        if (!beforeRefresh || beforeRefresh.disabled) {
          throw new PolicyError("VM access has been revoked");
        }
        if (classification.operation === "identity.read") {
          classification.repository =
            Object.keys(this.state.grants(instanceId))[0] ?? null;
          if (classification.repository === null) {
            throw new PolicyError("repository is not granted to this VM");
          }
        }
        const access = authorize(
          classification.repository === null
            ? null
            : this.state.grant(instanceId, classification.repository),
          classification.operation,
        );
        const token =
          access === "authenticated" && classification.repository !== null
            ? await this.auth.token(classification.repository)
            : null;
        const current = this.state.byId(instanceId);
        if (!current || current.disabled) {
          throw new PolicyError("VM access has been revoked");
        }
        revision = current.revision;
        const currentAccess = authorize(
          classification.repository === null
            ? null
            : this.state.grant(instanceId, classification.repository),
          classification.operation,
        );
        if (access === "authenticated" && currentAccess !== access) {
          throw new PolicyError("repository is not granted to this VM");
        }
        this.state.logDecision({
          id: requestId,
          instanceId,
          repository: classification.repository,
          operation: classification.operation,
          refs: classification.refs,
          allowed: true,
          reason: access === "anonymous" ? "anonymous read" : "granted",
          revision,
        });
        logged = true;
        if (isHealthCheck(classification)) {
          respondReady(response);
          settlement = { upstreamStatus: 200, outcome: "completed" };
        } else {
          settlement = await this.forward(
            request,
            response,
            host,
            target,
            requestHeaders(
              request.headers,
              token,
              host,
              classification.operation === "git.read" && method === "POST",
            ),
            classification,
            body,
          );
        }
      } else {
        throw new PolicyError("unsupported GitHub host");
      }
    } catch (error) {
      // Reading the body fails with the request's own error when the
      // connection closes before the body ends.
      const aborted = error === request.errored;
      const refusal =
        error instanceof PolicyError || error instanceof ModelUnavailable
          ? error
          : null;
      if (!aborted && refusal === null) {
        process.stderr.write(
          `cog: gateway request failed (request ${requestId}, VM ${instanceId}): ${describeFailure(error)}\n`,
        );
      }
      const reason = refusal?.message ?? "gateway request failed";
      const respond = (status: number, message: string): void => {
        // A keep-alive client that reuses a connection with an unread upload
        // on it waits out its timeout. Bun sets `complete` only after the
        // parser has delivered the body, so a body that has already arrived
        // can count as unread here, which costs that client a new connection.
        if (!request.complete && !hasNoBody(request.rawHeaders)) {
          response.setHeader("connection", "close");
        }
        if (modelHost) {
          const answer = modelRefusal(
            status === 403 ? 403 : 503,
            message,
            requestId,
            refusal !== null,
          );
          response.writeHead(status, answer.headers).end(answer.body);
          return;
        }
        const { contentType, body } = denial(
          request.headers.host?.toLowerCase() ?? "",
          request.url ?? "",
          message,
          requestId,
        );
        response.writeHead(status, { "content-type": contentType }).end(body);
      };
      if (logged) {
        this.state.finish(
          requestId,
          null,
          Date.now() - started,
          "gateway-error",
        );
      } else {
        try {
          this.state.logDecision({
            id: requestId,
            instanceId,
            repository: classification?.repository ?? null,
            operation: classification?.operation ?? "unknown",
            refs: classification?.refs ?? [],
            allowed: false,
            reason: aborted ? "request aborted" : reason,
            revision,
          });
          this.state.finish(
            requestId,
            null,
            Date.now() - started,
            aborted ? "interrupted" : "denied",
          );
        } catch (auditError) {
          process.stderr.write(`cog audit failure: ${String(auditError)}\n`);
          respond(503, "gateway audit unavailable");
          return;
        }
      }
      // Destroying only the response can leave the connection open, and the
      // requests pipelined around this one would then be answered out of
      // order.
      if (response.headersSent) {
        request.socket.destroy();
        return;
      }
      if (
        // git keeps sending after a 200 and shows a transport error, not these
        // ref statuses, unless the whole body is read.
        error instanceof PushDenied &&
        error.report !== null
      ) {
        let bodyDrained: boolean;
        try {
          bodyDrained = await drained(remaining, 67_108_864);
        } catch {
          bodyDrained = false;
        }
        if (bodyDrained) {
          response
            .writeHead(200, {
              "content-type": "application/x-git-receive-pack-result",
              "cache-control": "no-cache",
            })
            .end(error.report);
          return;
        }
      }
      respond(error instanceof PolicyError ? 403 : 503, reason);
      return;
    }
    this.state.finish(
      requestId,
      settlement.upstreamStatus,
      Date.now() - started,
      settlement.outcome,
    );
  }

  private async forward(
    incoming: IncomingMessage,
    response: ServerResponse,
    host: string,
    target: string,
    headers: http.OutgoingHttpHeaders,
    classification: Classification,
    body: RequestBody,
  ): Promise<Settlement> {
    const base = new URL(
      host === "github.com"
        ? (this.options.webUpstream ?? "https://github.com")
        : (this.options.apiUpstream ?? "https://api.github.com"),
    );
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.pathname !== "/" && base.pathname !== "/api/v3")
    ) {
      throw new Error("invalid upstream configuration");
    }
    const upstreamUrl = new URL(
      `${base.pathname.replace(/\/$/, "")}${target}`,
      base,
    );
    if (upstreamUrl.origin !== base.origin) {
      throw new Error("upstream target escaped its host");
    }
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    return this.relay(
      incoming,
      response,
      () =>
        transport.request(upstreamUrl, {
          method: incoming.method,
          headers,
          timeout: 60_000,
        }),
      (upstreamResponse) =>
        copyResponseHeaders(upstreamResponse.headers, classification),
      body,
    );
  }

  // Each host's credential comes only from its own source, and a fault in one
  // source stops only that host's credentialed requests.
  private credentialFor(model: ModelHost, instanceId: string): ModelCredential {
    if (model.credential === "pool") {
      if (this.pool === null) {
        // A load failure can name an account, which a guest is not told.
        throw new ModelUnavailable(
          this.poolReason === unconfiguredReason
            ? unconfiguredReason
            : "the Claude pool is not usable",
        );
      }
      const account = this.pool.choose(instanceId, Date.now());
      return {
        token: account.token,
        reason: `pool account ${account.name}`,
        account,
      };
    }
    const file = this.options.fireworksKeyFile;
    const result =
      file === undefined ? ({ kind: "missing" } as const) : readKeyFile(file);
    if (result.kind === "key") {
      this.fireworksReason = null;
      return { token: result.key, reason: "fireworks key", account: null };
    }
    const reason = result.kind === "missing" ? null : result.reason;
    if (reason !== null && reason !== this.fireworksReason) {
      process.stderr.write(`cog: Fireworks key file ${file ?? ""} ${reason}\n`);
    }
    this.fireworksReason = reason;
    throw new ModelUnavailable(fireworksUnusable);
  }

  // The target goes out as the request's path: a URL built from it would be
  // normalised, and the provider is to get the client's bytes.
  private forwardModel(
    incoming: IncomingMessage,
    response: ServerResponse,
    model: ModelHost,
    credential: ModelCredential | null,
    instanceId: string,
    target: string,
    remaining: AsyncIterator<Buffer>,
  ): Promise<Settlement> {
    const base = new URL(this.options[model.upstreamOption] ?? model.upstream);
    if (
      (base.protocol !== "https:" && base.protocol !== "http:") ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    ) {
      throw new Error("invalid upstream configuration");
    }
    const headers = modelRequestHeaders(
      incoming.rawHeaders,
      credential?.token ?? null,
    );
    const method = incoming.method ?? "";
    if (needsExplicitLength(method, incoming.rawHeaders)) {
      headers.push("Content-Length", "0");
    }
    const secure = base.protocol === "https:";
    const transport = secure ? https : http;
    const pool = this.pool;
    const started = Date.now();
    return this.relay(
      incoming,
      response,
      () =>
        transport.request(base, {
          method,
          path: target,
          headers,
          timeout: 600_000,
          agent: this.agentFor(instanceId, secure),
        }),
      (upstreamResponse) => {
        if (credential?.account) {
          pool?.observe(
            credential.account.name,
            upstreamResponse.statusCode ?? 0,
            upstreamResponse.rawHeaders,
            Date.now(),
            started,
          );
        }
        return modelResponseHeaders(upstreamResponse.rawHeaders);
      },
      { buffered: Buffer.alloc(0), remaining },
      isReplayable(method, incoming.rawHeaders),
    );
  }

  private async relay(
    incoming: IncomingMessage,
    response: ServerResponse,
    open: () => http.ClientRequest,
    relayedHeaders: (
      upstreamResponse: IncomingMessage,
    ) => http.OutgoingHttpHeaders | string[],
    body: RequestBody,
    retryable = false,
  ): Promise<Settlement> {
    // The client may have left while the request was being authorized. The
    // response counts as destroyed only once it emits "close", which can trail
    // the destruction of its socket, so both are checked.
    if (response.destroyed || incoming.socket.destroyed) {
      return { upstreamStatus: null, outcome: "interrupted" };
    }
    let upstream: http.ClientRequest | null = null;
    // The server stops reporting a client that leaves mid-upload once the
    // response has finished, so an upstream that answers early would keep its
    // half-sent request open.
    const abandon = (): void => {
      upstream?.destroy();
    };
    const watching = !incoming.complete && !hasNoBody(incoming.rawHeaders);
    if (watching) {
      incoming.socket.once("close", abandon);
    }
    const result = new Promise<Settlement>((resolve, reject) => {
      let settled = false;
      let upstreamStatus: number | null = null;
      const settle = (outcome: Settlement["outcome"]): void => {
        settled = true;
        resolve({ upstreamStatus, outcome });
      };
      response.once("close", () => {
        // A response that already completed leaves the upstream request alone,
        // so an upstream that answered before the upload ended stays open until
        // abandon() ends it when the client's connection closes. Bun reports
        // writableFinished for a response that was ended after its socket was
        // destroyed, and never emits "finish" for it, so only settled shows
        // that the response completed.
        if (settled) {
          return;
        }
        settle("interrupted");
        upstream?.destroy();
      });
      const begin = (replay: boolean): void => {
        const current = open();
        upstream = current;
        current.once("close", () => {
          if (watching && upstream === current) {
            incoming.socket.off("close", abandon);
          }
        });
        let answered = false;
        const upstreamDone = Promise.withResolvers<undefined>();
        current.once("close", upstreamDone.resolve);
        const fail = (error: Error): void => {
          reject(error);
          current.destroy();
        };
        // Bun's client emits neither "response" nor "error" for a 101 answer.
        current.once("upgrade", (_response, upgraded) => {
          upgraded.destroy();
          fail(new Error("upstream tried to switch protocols"));
        });
        current.once("response", (upstreamResponse) => {
          answered = true;
          upstreamStatus = upstreamResponse.statusCode ?? 502;
          const relayed = relayedHeaders(upstreamResponse);
          const reason = upstreamResponse.statusMessage;
          // The parser accepts a status line such as "099", which writeHead
          // rejects by throwing, and nothing catches a throw from this
          // listener. A reason phrase that writeHead rejects stays on the
          // response and makes the 503 that handle() sends throw as well.
          try {
            if (reason !== undefined && reasonPhrase.test(reason)) {
              response.writeHead(upstreamStatus, reason, relayed);
            } else {
              response.writeHead(upstreamStatus, relayed);
            }
            response.flushHeaders();
          } catch (error) {
            // writeHead can throw after it stored some of the headers, and the
            // 503 that handle() sends would carry them.
            for (const name of headerNames(relayed)) {
              response.removeHeader(name);
            }
            fail(error instanceof Error ? error : new Error("response failed"));
            return;
          }
          upstreamResponse.once("end", upstreamDone.resolve);
          upstreamResponse.pipe(response);
          // An upstream that closes mid-body never ends the pipe, and Node
          // reports that on the response only while an "error" listener
          // exists.
          upstreamResponse.once("error", fail);
          response.once("finish", () => {
            settle("completed");
          });
        });
        // A kept-alive socket that the peer closed or reset while it was idle
        // fails the first request on it: with ECONNRESET when the close is
        // read after the request is written, and with EPIPE when a reset came
        // in before the write. Only a safe request with no body is sent again,
        // and it is sent again until a fresh socket carries it, since every
        // idle socket of the VM may have gone stale together.
        current.once("error", (error: Error & { code?: string }) => {
          if (
            retryable &&
            !answered &&
            !settled &&
            (error.code === "ECONNRESET" || error.code === "EPIPE") &&
            current.reusedSocket
          ) {
            try {
              begin(true);
            } catch (retryError) {
              reject(
                retryError instanceof Error
                  ? retryError
                  : new Error("request failed"),
              );
            }
            return;
          }
          fail(error);
        });
        current.once("timeout", () => {
          current.destroy(new Error("upstream timed out"));
        });
        if (replay) {
          current.end();
        } else {
          void sendBody(current, body, upstreamDone.promise).catch(
            (error: unknown) => {
              current.destroy(
                error instanceof Error
                  ? error
                  : new Error("request body failed"),
              );
            },
          );
        }
      };
      // open() can throw before an upstream request exists to take the
      // listener off when it closes.
      try {
        begin(false);
      } catch (error) {
        if (watching) {
          incoming.socket.off("close", abandon);
        }
        throw error;
      }
    });
    return result;
  }
}
