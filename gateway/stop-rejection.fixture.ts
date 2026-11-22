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

// Run by server.test.ts in its own process. bun test fails the running test
// on any unhandled rejection and never calls process handlers for it, so a
// rejection that must be observed has to happen outside the test runner.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AppAuth } from "./auth.ts";
import { Gateway } from "./server.ts";
import { State } from "./state.ts";

const [cert, key, scenario] = process.argv.slice(2);
if (
  !cert ||
  !key ||
  !["interrupted", "completed", "health"].includes(scenario ?? "")
) {
  throw new Error(
    "usage: stop-rejection.fixture.ts CERT KEY interrupted|completed|health",
  );
}

const rejections: unknown[] = [];
const reported = Promise.withResolvers<undefined>();
process.on("unhandledRejection", (reason) => {
  rejections.push(reason instanceof Error ? reason.message : reason);
  reported.resolve(undefined);
});

const root = mkdtempSync(path.join(tmpdir(), "cog-rejection-"));
const state = new State(path.join(root, "state"));
try {
  const secrets = path.join(root, "secrets");
  mkdirSync(secrets);
  const auth = new AppAuth(secrets);
  const socket = path.join(root, "work.sock");
  state.register("lima:work", socket, "tester");
  state.update(
    "lima:work",
    0,
    { "shields/dotfiles": { read: true, pushCogBranches: true } },
    "tester",
  );
  const events: string[] = [];
  const asked = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  auth.token = async (): Promise<string> => {
    asked.resolve(undefined);
    await resume.promise;
    events.push("token");
    return "ghu_secret";
  };
  const finishes: string[] = [];
  state.finish = (
    _id: string,
    _status: number | null,
    _durationMs: number,
    outcome: string,
  ): never => {
    finishes.push(outcome);
    throw new Error("audit write failed");
  };
  const upstream = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-length": 2 }).end("ok");
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  // A referenced server that is listening delays Bun's delivery of an
  // unhandled rejection raised after a setImmediate until the event loop next
  // wakes.
  upstream.unref();
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("the upstream did not listen on a port");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;

  const createServer = https.createServer.bind(https);
  const listeners: https.Server[] = [];
  const closes: Promise<unknown>[] = [];
  https.createServer = ((...args: Parameters<typeof https.createServer>) => {
    const server = createServer(...args);
    listeners.push(server);
    server.on("request", (_request, response) => {
      closes.push(once(response, "close"));
    });
    return server;
  }) as typeof https.createServer;
  const gateway = new Gateway(state, auth, {
    cert,
    key,
    adminSocket: path.join(root, "admin.sock"),
    webUpstream: origin,
    apiUpstream: origin,
  });
  await gateway.start();
  const listener = listeners[0];
  if (!listener) {
    throw new Error("the gateway did not create a listener");
  }

  const asRequested = (host: string, target: string): https.RequestOptions => ({
    socketPath: socket,
    servername: host,
    rejectUnauthorized: false,
    method: "GET",
    path: target,
    agent: false,
    headers: { host },
  });
  const shutdown = async (): Promise<void> => {
    await gateway.stop();
    events.push("stopped");
  };
  if (scenario === "interrupted") {
    const request = https.request(
      asRequested(
        "github.com",
        "/shields/dotfiles.git/info/refs?service=git-upload-pack",
      ),
    );
    const hungUp = Promise.withResolvers<Error>();
    request.once("error", hungUp.resolve);
    request.end();
    await asked.promise;
    request.destroy();
    await hungUp.promise;
    await Promise.all(closes);

    const stopping = shutdown();
    await once(listener, "close");
    await nextTurn();
    resume.resolve(undefined);
    await reported.promise;
    await stopping;
  } else {
    resume.resolve(undefined);
    const [host, target] =
      scenario === "health"
        ? ["api.github.com", "/__cog__/health"]
        : [
            "github.com",
            "/shields/dotfiles.git/info/refs?service=git-upload-pack",
          ];
    const request = https.request(asRequested(host, target));
    const answered = Promise.withResolvers<number | undefined>();
    request.once("response", (response) => {
      response.resume();
      answered.resolve(response.statusCode);
    });
    request.once("error", answered.reject);
    request.end();
    assert.equal(await answered.promise, 200);
    await reported.promise;
    await shutdown();
  }
  await nextTurn();
  upstream.closeAllConnections();
  upstream.close();
  process.stdout.write(JSON.stringify({ events, rejections, finishes }));
} finally {
  state.close();
  rmSync(root, { recursive: true, force: true });
}
