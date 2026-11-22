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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, onTestFinished, spyOn, test } from "bun:test";
import { AppAuth } from "../gateway/auth.ts";
import { cloudCommand } from "./commands/cloud.ts";
import { loadConfig } from "./config.ts";

const token = "ab".repeat(32);
const id = "12345678-abcd-abcd-abcd-123456789abc";
const vm = {
  id,
  name: "trial",
  disabled: false,
  revision: 2,
  grants: { "a/old": { read: true, pushCogBranches: true } },
};
const root = mkdtempSync("/tmp/cog-cloud-");
const key = path.join(root, "key.pem");
const cert = path.join(root, "cert.pem");
const realFetch = globalThis.fetch;

beforeAll(() => {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(path.join(root, "home-"));
  const config = loadConfig({
    HOME: home,
    COG_PROFILES: path.join(home, "nonexistent"),
  });
  const secretDir = path.join(home, ".config", "secrets", "cog");
  mkdirSync(secretDir, { recursive: true });
  const tokenFile = path.join(secretDir, "cloudflare-admin-token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return {
    run: (args: string[]) => cloudCommand(args, config),
    cli: async (args: string[], env: Record<string, string> = {}) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--no-env-file",
          path.join(import.meta.dirname, "main.ts"),
          ...args,
        ],
        {
          cwd: home,
          env: { HOME: home, ...env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    },
    urlFile: path.join(home, ".config", "cog", "cloudflare-url"),
    tokenFile,
  };
}

function worker(reply: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: reply,
  });
  const ca = readFileSync(cert, "utf8");
  const fetchWithCA = (
    input: Parameters<typeof fetch>[0],
    init?: BunFetchRequestInit,
  ) => realFetch(input, { ...init, proxy: false, tls: { ...init?.tls, ca } });
  const trust = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fetchWithCA, { preconnect: realFetch.preconnect }),
  );
  onTestFinished(async () => {
    trust.mockRestore();
    await server.stop(true);
  });
  return server.url.origin;
}

test("cloud commands use an HTTPS Worker and put the admin token only in Authorization", async () => {
  const { run, urlFile } = setup();
  const flow = spyOn(AppAuth.prototype, "issue").mockResolvedValue({
    client_id: "unused",
    repository: "a/b",
    web_url: "https://github.com",
    api_url: "https://api.github.com",
    access_token: "ghu_fake",
    access_expires_at: 100,
    refresh_token: "ghr_fake",
    refresh_expires_at: 200,
  });
  onTestFinished(() => {
    flow.mockRestore();
  });
  const seen: { method: string; route: string; body: unknown }[] = [];
  const base = `/instances/${id}`;
  const origin = worker(async (request) => {
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const text = await request.text();
    assert.equal(
      JSON.stringify({
        url: request.url,
        headers: [...headers],
        text,
      }).includes(token),
      false,
    );
    const body: unknown = text === "" ? null : JSON.parse(text);
    const route = new URL(request.url).pathname;
    const { method } = request;
    seen.push({ method, route, body });
    switch (`${method} ${route}`) {
      case "POST /authorizations":
      case `DELETE ${base}`:
        return new Response(null, { status: 204 });
      case "GET /instances":
        return Response.json([vm]);
      case "POST /instances":
        return Response.json(vm, { status: 201 });
      case `GET ${base}`:
        return Response.json(vm);
      case `PUT ${base}/grants`:
        return Response.json({ revision: 3 });
      case `POST ${base}/start`:
        return Response.json({ started: true, running: true });
      case `GET ${base}/logs`:
        return Response.json([{ decision: "allow" }]);
      case `GET ${base}/events`:
        return Response.json([{ revision: 2 }]);
      default:
        return new Response(null, { status: 404 });
    }
  });
  assert.deepEqual(await run(["config", `${origin}/`]), { url: origin });
  assert.equal(readFileSync(urlFile, "utf8"), `${origin}\n`);
  assert.equal(statSync(urlFile).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(urlFile)).mode & 0o777, 0o700);
  assert.deepEqual(await run(["authorize", "A/B"]), { authorized: "a/b" });
  assert.deepEqual(
    flow.mock.calls.map(([repository, options]) => [
      repository,
      options?.hostname,
    ]),
    [["a/b", "github.com"]],
  );
  assert.deepEqual(await run(["new", "trial"]), vm);
  assert.deepEqual(await run(["list"]), [vm]);
  assert.deepEqual(await run(["show", id]), vm);
  assert.deepEqual(await run(["start", id]), { started: true, running: true });
  assert.deepEqual(await run(["logs", id]), [{ decision: "allow" }]);
  assert.deepEqual(await run(["events", id]), [{ revision: 2 }]);
  for (const options of [["--profile"], ["--profile", "constructor"]]) {
    await assert.rejects(run(["grant", id, "A/New", ...options]), {
      message: "usage: cog cloud grant VM-ID OWNER/REPO [--profile read|cog]",
    });
  }
  assert.deepEqual(await run(["grant", id, "A/New"]), { revision: 3 });
  assert.deepEqual(await run(["grant", id, "A/New", "--profile", "read"]), {
    revision: 3,
  });
  assert.deepEqual(await run(["revoke", id, "A/Old"]), { revision: 3 });
  assert.deepEqual(await run(["rm", id]), { deleted: id });
  assert.deepEqual(seen, [
    {
      method: "POST",
      route: "/authorizations",
      body: {
        repository: "a/b",
        accessToken: "ghu_fake",
        accessExpiresAt: 100,
        refreshToken: "ghr_fake",
        refreshExpiresAt: 200,
      },
    },
    { method: "POST", route: "/instances", body: { name: "trial" } },
    { method: "GET", route: "/instances", body: null },
    { method: "GET", route: base, body: null },
    { method: "POST", route: `${base}/start`, body: null },
    { method: "GET", route: `${base}/logs`, body: null },
    { method: "GET", route: `${base}/events`, body: null },
    { method: "GET", route: base, body: null },
    {
      method: "PUT",
      route: `${base}/grants`,
      body: {
        revision: 2,
        grants: {
          ...vm.grants,
          "a/new": { read: true, pushCogBranches: true },
        },
      },
    },
    { method: "GET", route: base, body: null },
    {
      method: "PUT",
      route: `${base}/grants`,
      body: {
        revision: 2,
        grants: {
          ...vm.grants,
          "a/new": { read: true, pushCogBranches: false },
        },
      },
    },
    { method: "GET", route: base, body: null },
    {
      method: "PUT",
      route: `${base}/grants`,
      body: { revision: 2, grants: {} },
    },
    { method: "DELETE", route: base, body: null },
  ]);
});

test("cloud runs outside the checkout with strict, quiet TLS and no Lima base", async () => {
  const { run, cli } = setup();
  let requests = 0;
  const origin = worker(() => {
    requests += 1;
    return Response.json([]);
  });
  await run(["config", origin]);
  const trusted = await cli(["cloud", "list"], {
    COG_BASE: "not a Lima name",
    NODE_EXTRA_CA_CERTS: cert,
    BUN_CONFIG_VERBOSE_FETCH: "curl",
  });
  assert.equal(trusted.status, 0);
  assert.equal(trusted.stdout, "[]\n");
  assert.equal(trusted.stderr === "", true);

  const untrusted = await cli(["cloud", "list"], {
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  assert.equal(untrusted.status, 1);
  assert.equal(untrusted.stdout, "");
  assert.match(untrusted.stderr, /cog: Cloudflare request failed\n/);
  assert.equal(requests, 1);
});

test("help does not echo the configured GitHub URL", async () => {
  const { cli } = setup();
  const endpoint = "https://user:fixture@example.invalid";
  const result = await cli(["help"], { COG_GITHUB_WEB_URL: endpoint });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /COG_GITHUB_WEB_URL/);
  assert.equal(result.stdout.includes(endpoint), false);
});

test("cloud refuses non-HTTPS and non-origin URLs before sending a request", async () => {
  const { run, urlFile } = setup();
  let requests = 0;
  const plain = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json([]);
    },
  });
  onTestFinished(async () => {
    await plain.stop(true);
  });
  for (const invalid of [
    plain.url.origin,
    "not-a-url",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?",
    "https://example.com#",
  ]) {
    await assert.rejects(run(["config", invalid]), {
      message: "Cloudflare URL must be a bare HTTPS origin",
    });
  }
  mkdirSync(path.dirname(urlFile));
  writeFileSync(urlFile, plain.url.origin);
  await assert.rejects(run(["list"]), {
    message: "Cloudflare URL must be a bare HTTPS origin",
  });
  assert.equal(requests, 0);
});

test("cloud refuses even a same-origin redirect", async () => {
  const { run } = setup();
  const paths: string[] = [];
  const origin = worker((request) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    return url.pathname === "/instances"
      ? Response.redirect(new URL("/target", url))
      : Response.json([]);
  });
  await run(["config", origin]);
  await assert.rejects(run(["list"]), { message: "Cloudflare request failed" });
  assert.deepEqual(paths, ["/instances"]);
});

test("cloud grant distinguishes missing authorization from concurrent edits", async () => {
  const { run } = setup();
  const failures = [
    "GitHub authorization for a/b is missing",
    "policy changed while editing",
  ];
  const origin = worker((request) =>
    request.method === "GET"
      ? Response.json(vm)
      : Response.json({ error: failures.shift() }, { status: 403 }),
  );
  await run(["config", origin]);
  await assert.rejects(run(["grant", id, "a/b"]), {
    message:
      "a repository is missing GitHub authorization; run cog cloud authorize OWNER/REPO",
  });
  await assert.rejects(run(["grant", id, "a/b"]), {
    message: "policy changed while editing; retry the command",
  });
});

test("cloud authorize distinguishes device expiry without quoting unknown failures", async () => {
  const { run } = setup();
  const flow = spyOn(AppAuth.prototype, "issue")
    .mockRejectedValueOnce(new Error("GitHub device code for a/b expired"))
    .mockRejectedValue(new Error(token));
  onTestFinished(() => {
    flow.mockRestore();
  });
  await run(["config", "https://example.invalid"]);
  await assert.rejects(run(["authorize", "a/b"]), {
    message: "GitHub device code expired; run cog cloud authorize again",
  });
  await assert.rejects(run(["authorize", "a/b"]), {
    message: "GitHub device authorization failed",
  });
});

test("cloud errors and successful responses cannot echo the admin token", async () => {
  const { run, tokenFile } = setup();
  const replies = [
    Response.json({ error: token }, { status: 403 }),
    new Response(`not JSON: ${token}`),
    Response.json({ token }),
    Response.json({ revision: 3, grants: { "a/b": { read: false } } }),
  ];
  const origin = worker(
    () => replies.shift() ?? new Response(null, { status: 500 }),
  );
  await run(["config", origin]);
  await assert.rejects(run(["list"]), {
    message: "Cloudflare request failed with HTTP 403",
  });
  await assert.rejects(run(["list"]), {
    message: "Cloudflare returned invalid JSON",
  });
  await assert.rejects(run(["list"]), {
    message: "Cloudflare returned the admin token",
  });
  await assert.rejects(run(["grant", id, "A/B"]), {
    message: "Cloudflare returned an invalid VM policy",
  });
  writeFileSync(tokenFile, `${token} extra`);
  await assert.rejects(run(["list"]), {
    message: "Cloudflare admin token file is invalid",
  });
  assert.deepEqual(replies, []);
});
