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
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import YAML from "yaml";
import { loadConfig } from "../cog/config.ts";
import { AppAuth } from "./auth.ts";
import { ensureCertificates } from "./cert.ts";
import {
  Control,
  controlOptions,
  locations,
  parseEdit,
  policyDocument,
  RegistrationFailedHere,
  socketName,
} from "./control.ts";
import { compareCodeUnits, type Grant } from "./policy.ts";
import { State } from "./state.ts";

const read: Grant = { read: true, pushCogBranches: false };
const cog: Grant = { read: true, pushCogBranches: true };

function root(): string {
  const directory = mkdtempSync("/tmp/cog-");
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function control(
  directory: string,
  extra: Record<string, string> = {},
): Control {
  const result = new Control(locations({ COG_ROOT: directory, ...extra }), {
    ...controlOptions({ COG_ROOT: directory, ...extra }),
    actor: "tester",
  });
  onTestFinished(() => {
    result.close();
  });
  return result;
}

function authorization(
  directory: string,
  repository: string,
  refreshExpiresAt = Math.floor(Date.now() / 1000) + 86_400,
): void {
  const secrets = path.join(directory, "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(
    path.join(secrets, `${Buffer.from(repository).toString("base64url")}.json`),
    JSON.stringify({
      client_id: "Iv-test",
      repository,
      access_token: "ghu_test",
      access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "ghr_test",
      refresh_expires_at: refreshExpiresAt,
      web_url: "https://github.com",
      api_url: "https://api.github.com",
    }),
  );
}

test("locations come from COG_ROOT, else from HOME", () => {
  assert.deepEqual(locations({ COG_ROOT: "/r" }), {
    state: "/r/state",
    sockets: "/r/state/sock",
    secrets: "/r/secrets",
    admin: "/r/state/admin.sock",
    pool: "/r/secrets/claude-pool",
  });
  assert.deepEqual(locations({ HOME: "/h" }), {
    state: "/h/.local/state/cog",
    sockets: "/h/.local/state/cog/sock",
    secrets: "/h/.config/secrets/cog",
    admin: "/h/.local/state/cog/admin.sock",
    pool: "/h/.config/secrets/cog/claude-pool",
  });
  assert.throws(() => locations({}), /HOME is not set/);
  assert.throws(() => locations({ HOME: "" }), /HOME is not set/);
});

test("nothing is created until the state or the authorizations are used", () => {
  const directory = root();
  const result = control(directory);
  assert.equal(existsSync(path.join(directory, "state")), false);
  assert.equal(existsSync(path.join(directory, "secrets")), false);
  assert.deepEqual(result.state.active(), []);
  assert.equal(existsSync(path.join(directory, "state")), true);
  assert.equal(existsSync(path.join(directory, "secrets")), false);
  assert.equal(result.auth.has("shields/dotfiles"), false);
  assert.equal(existsSync(path.join(directory, "secrets")), true);
});

test("the state refuses the configured base as well as cog-base", () => {
  const directory = root();
  const result = control(directory, { COG_BASE: "my-base" });
  for (const name of ["lima:my-base", "lima:cog-base"]) {
    assert.throws(
      () =>
        result.state.register(name, path.join(directory, "x.sock"), "tester"),
      /invalid VM name/,
      name,
    );
  }
  assert.equal(
    result.state.register("lima:t1", path.join(directory, "t1.sock"), "tester")
      .name,
    "lima:t1",
  );
});

test("register checks the socket path before it touches anything", async () => {
  const directory = root();
  const result = control(path.join(directory, "x".repeat(120)));
  await assert.rejects(result.register("lima:t1"), (error: unknown) => {
    assert.ok(error instanceof RegistrationFailedHere);
    assert.equal(
      error.message,
      "the state directory is too long for a Unix socket",
    );
    return true;
  });
  assert.deepEqual(readdirSync(directory), []);
});

test("a registration that fails in this process is told apart from one that the daemon fails", async () => {
  const directory = root();
  const result = control(directory);
  await assert.rejects(result.register("lima:t1"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof RegistrationFailedHere, false);
    return true;
  });
  result.state.register(
    "lima:t2",
    path.join(result.location.sockets, "github-ab-12.sock"),
    "tester",
  );
  await assert.rejects(result.register("lima:t2"), (error: unknown) => {
    assert.ok(error instanceof RegistrationFailedHere);
    assert.equal(error.message, "VM is already registered");
    return true;
  });
  writeFileSync(path.join(result.location.secrets, "ca.pem"), "");
  rmSync(path.join(result.location.secrets, "ca-key.pem"));
  await assert.rejects(result.register("lima:t3"), (error: unknown) => {
    assert.ok(error instanceof RegistrationFailedHere);
    assert.match(error.message, /^gateway CA files are incomplete: /);
    return true;
  });
  assert.equal(result.state.byName("lima:t3"), null);
}, 60_000);

test("register is undone when the daemon cannot be told", async () => {
  const directory = root();
  const result = control(directory);
  await assert.rejects(result.register("lima:t1"));
  assert.equal(statSync(result.location.sockets).mode & 0o777, 0o700);
  assert.equal(result.state.byName("lima:t1"), null);
  assert.deepEqual(result.state.active(), []);
  const [row] = result.state.db
    .prepare("SELECT id, socket, disabled FROM instances")
    .all() as unknown as { id: string; socket: string; disabled: number }[];
  assert.ok(row);
  assert.equal(row.disabled, 1);
  assert.equal(path.dirname(row.socket), result.location.sockets);
  assert.match(path.basename(row.socket), /^github-[0-9a-f-]{36}\.sock$/);
  assert.deepEqual(
    result.state
      .events(row.id)
      .map((event) => JSON.stringify(event.changes))
      .toSorted(compareCodeUnits),
    [
      JSON.stringify({ disabled: true, removed: {} }),
      JSON.stringify({ registered: true }),
    ],
  );
}, 60_000);

test("disable fails without a daemon but keeps the VM disabled", async () => {
  const directory = root();
  const result = control(directory);
  const instance = result.state.register(
    "lima:t1",
    path.join(directory, "t1.sock"),
    "tester",
  );
  await assert.rejects(result.disable("lima:t1"));
  assert.equal(result.state.byName("lima:t1"), null);
  assert.equal(result.state.byId(instance.id)?.disabled, true);
});

test("health fails without a daemon", async () => {
  const result = control(root());
  await assert.rejects(result.health());
});

test.each([
  ["health", (result: Control) => result.health()],
  ["sync", (result: Control) => result.sync()],
] as const)(
  "%s rejects an answer larger than it can ask for",
  async (_, call) => {
    const directory = root();
    const result = control(directory);
    mkdirSync(path.dirname(result.location.admin), { recursive: true });
    const server = http.createServer((_request, response) => {
      response.writeHead(200).end(" ".repeat(4097));
    });
    await new Promise<void>((resolve) => {
      server.listen(result.location.admin, resolve);
    });
    onTestFinished(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });
    await assert.rejects(call(result), /answer too big/);
  },
);

test("grant checks the repository and then the VM", async () => {
  const directory = root();
  const result = control(directory);
  await assert.rejects(
    result.grant("lima:t1", "not a repository", cog),
    /repository/,
  );
  await assert.rejects(
    result.grant("lima:t1", "shields/dotfiles", cog),
    /lima:t1 is not a registered VM/,
  );
});

test("grant and revoke change the policy one revision at a time", async () => {
  const directory = root();
  authorization(directory, "shields/dotfiles");
  const result = control(directory);
  const instance = result.state.register(
    "lima:t1",
    path.join(directory, "t1.sock"),
    "tester",
  );
  assert.equal(await result.grant("lima:t1", "Shields/Dotfiles", cog), 1);
  assert.deepEqual(result.state.grants(instance.id), {
    "shields/dotfiles": cog,
  });
  assert.equal(await result.grant("lima:t1", "shields/dotfiles", cog), 1);
  assert.equal(await result.grant("lima:t1", "shields/dotfiles", read), 2);
  assert.throws(
    () => result.revoke("lima:t1", "shields/other"),
    /shields\/other is not granted to lima:t1/,
  );
  assert.equal(result.revoke("lima:t1", "SHIELDS/dotfiles"), 3);
  assert.deepEqual(result.state.grants(instance.id), {});
  assert.throws(
    () => result.revoke("lima:nope", "shields/dotfiles"),
    /lima:nope is not a registered VM/,
  );
});

test("show names the state of each authorization", () => {
  const directory = root();
  authorization(directory, "shields/dotfiles");
  authorization(directory, "shields/old", 1);
  const result = control(directory);
  const instance = result.state.register(
    "lima:t1",
    path.join(directory, "t1.sock"),
    "tester",
  );
  result.state.update(
    "lima:t1",
    0,
    { "shields/dotfiles": cog, "shields/old": read, "shields/none": read },
    "tester",
  );
  const shown = YAML.parse(result.show("lima:t1")) as Record<string, unknown>;
  assert.equal(shown.vm, "lima:t1");
  assert.equal(shown.id, instance.id);
  assert.equal(shown.revision, 1);
  assert.equal(shown.branchPrefix, `cog/${instance.id}/`);
  assert.deepEqual(shown.authorization, {
    "shields/dotfiles": "available",
    "shields/none": "missing",
    "shields/old": "expired",
  });
});

test("an edit is parsed against the VM it came from", async () => {
  const directory = root();
  authorization(directory, "shields/dotfiles");
  const result = control(directory);
  result.state.register("lima:t1", path.join(directory, "t1.sock"), "tester");
  result.state.update("lima:t1", 0, { "shields/dotfiles": cog }, "tester");
  const { instance, document } = result.beginEdit("lima:t1");
  assert.equal(document, policyDocument(result.state, instance));
  const parsed = parseEdit(document, instance);
  assert.deepEqual(parsed, {
    revision: 1,
    repositories: { "shields/dotfiles": cog },
  });
  const changed = document.replace(
    "pushCogBranches: true",
    "pushCogBranches: false",
  );
  assert.equal(await result.commitEdit("lima:t1", instance, changed), 2);
  await assert.rejects(
    result.commitEdit("lima:t1", instance, document),
    /policy changed while editing: expected revision 1, now 2/,
  );
  for (const bad of [
    document.replace("vm: lima:t1", "vm: lima:other"),
    document.replace(instance.id, "x"),
    document.replace(/branchPrefix: .*/, "branchPrefix: refs/heads/x/"),
    document.replace("revision: 1", "revision: 1.5"),
    document.replace(/^id: .*$/m, ""),
    "- a\n",
    "a: [\n",
  ]) {
    await assert.rejects(
      result.commitEdit("lima:t1", instance, bad),
      (error: unknown) => error instanceof Error,
    );
  }
});

test("logs find a VM by name, then by ID, even when it is disabled", () => {
  const directory = root();
  const result = control(directory);
  const instance = result.state.register(
    "lima:t1",
    path.join(directory, "t1.sock"),
    "tester",
  );
  result.state.update("lima:t1", 0, { "shields/dotfiles": read }, "tester");
  const byName = result.findInstance("lima:t1");
  assert.equal(byName.id, instance.id);
  assert.deepEqual(
    result.logs(byName, 100).map((entry) => entry.kind),
    ["policy", "policy"],
  );
  result.state.disable("lima:t1", "tester");
  assert.throws(
    () => result.findInstance("lima:t1"),
    /lima:t1 is not a known VM/,
  );
  const disabled = result.findInstance(instance.id);
  assert.equal(disabled.disabled, true);
  assert.equal(result.logs(disabled, -1).length, 3);
  assert.throws(
    () => result.findInstance("nothing"),
    /nothing is not a known VM/,
  );
});

async function answering(
  directory: string,
  reply: { status?: number; body: string },
): Promise<void> {
  const result = control(directory);
  mkdirSync(path.dirname(result.location.admin), { recursive: true });
  const server = http.createServer((request, response) => {
    response
      .writeHead(request.url === "/pool" ? (reply.status ?? 200) : 404)
      .end(reply.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(result.location.admin, resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
}

const usableAnswer = {
  state: "usable",
  reason: null,
  accounts: [
    {
      name: "alpha",
      held: true,
      heldUntil: 1_800_000_000_000,
      buckets: [{ bucket: "5h", utilization: 0.5, expires: 1_800_000_001_000 }],
    },
  ],
};

test("pool returns the answer of the daemon", async () => {
  const directory = root();
  await answering(directory, { body: JSON.stringify(usableAnswer) });
  assert.deepEqual(await control(directory).pool(), usableAnswer);
  const other = root();
  await answering(other, {
    body: JSON.stringify({ state: "unconfigured", reason: null, accounts: [] }),
  });
  assert.deepEqual(await control(other).pool(), {
    state: "unconfigured",
    reason: null,
    accounts: [],
  });
  const third = root();
  await answering(third, {
    body: JSON.stringify({
      state: "unusable",
      reason: "account alpha is not a regular file",
      accounts: [],
    }),
  });
  assert.equal(
    (await control(third).pool()).reason,
    "account alpha is not a regular file",
  );
});

test("pool fails without a daemon and when the daemon refuses", async () => {
  await assert.rejects(control(root()).pool());
  const directory = root();
  await answering(directory, { status: 503, body: "" });
  await assert.rejects(
    control(directory).pool(),
    /gateway administration failed/,
  );
});

test("pool fails when the daemon closes the connection before its answer is complete", async () => {
  const directory = root();
  const result = control(directory);
  mkdirSync(path.dirname(result.location.admin), { recursive: true });
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{"state":');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(result.location.admin, resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  await assert.rejects(result.pool(), /answer was cut off/);
});

test("pool says that a daemon which does not know the route is older than this cog", async () => {
  const directory = root();
  await answering(directory, { status: 404, body: "" });
  await assert.rejects(
    control(directory).pool(),
    /the running gateway is older than this cog; run \.\/install\.sh/,
  );
});

const malformed: [string, string, RegExp][] = [
  ["text", "not json", /invalid JSON/],
  ["an array", "[]", /invalid pool state/],
  ["null", "null", /invalid pool state/],
  [
    "an unknown state",
    JSON.stringify({ ...usableAnswer, state: "broken" }),
    /invalid pool state/,
  ],
  [
    "no accounts list",
    JSON.stringify({ state: "usable", reason: null }),
    /invalid pool state/,
  ],
  [
    "a reason with a usable pool",
    JSON.stringify({ ...usableAnswer, reason: "why" }),
    /invalid pool reason/,
  ],
  [
    "an unusable pool without a reason",
    JSON.stringify({ state: "unusable", reason: null, accounts: [] }),
    /invalid pool reason/,
  ],
  [
    "accounts of an unusable pool",
    JSON.stringify({ ...usableAnswer, state: "unusable", reason: "why" }),
    /cannot use/,
  ],
  [
    "an account with a name that is not allowed",
    JSON.stringify({
      ...usableAnswer,
      accounts: [{ ...usableAnswer.accounts[0], name: "../x" }],
    }),
    /invalid pool account/,
  ],
  [
    "an account that is held in a string",
    JSON.stringify({
      ...usableAnswer,
      accounts: [{ ...usableAnswer.accounts[0], held: "yes" }],
    }),
    /invalid pool account/,
  ],
  [
    "a hold until a string",
    JSON.stringify({
      ...usableAnswer,
      accounts: [{ ...usableAnswer.accounts[0], heldUntil: "soon" }],
    }),
    /invalid pool account/,
  ],
  [
    "buckets that are not a list",
    JSON.stringify({
      ...usableAnswer,
      accounts: [{ ...usableAnswer.accounts[0], buckets: {} }],
    }),
    /invalid pool account/,
  ],
  [
    "a bucket with a utilization that is a string",
    JSON.stringify({
      ...usableAnswer,
      accounts: [
        {
          ...usableAnswer.accounts[0],
          buckets: [{ bucket: "5h", utilization: "0.5", expires: 1 }],
        },
      ],
    }),
    /invalid pool bucket/,
  ],
];

for (const [name, body, message] of malformed) {
  test(`pool rejects an answer with ${name}`, async () => {
    const directory = root();
    await answering(directory, { body });
    await assert.rejects(control(directory).pool(), message);
  });
}

test("pool rejects an answer that is larger than a megabyte", async () => {
  const directory = root();
  await answering(directory, { body: " ".repeat(1_048_577) });
  await assert.rejects(control(directory).pool(), /too big/);
});

test("pool shows no field that the daemon added", async () => {
  const directory = root();
  await answering(directory, {
    body: JSON.stringify({
      ...usableAnswer,
      token: "extra",
      accounts: [{ ...usableAnswer.accounts[0], token: "extra" }],
    }),
  });
  const answer = await control(directory).pool();
  assert.ok(!JSON.stringify(answer).includes("extra"));
});

test("the socket directory is made private and must be a real directory", () => {
  const directory = root();
  const result = control(directory);
  mkdirSync(result.location.state, { recursive: true });
  result.ensureSocketDirectory();
  assert.equal(statSync(result.location.sockets).mode & 0o777, 0o700);
  chmodSync(result.location.sockets, 0o755);
  result.ensureSocketDirectory();
  assert.equal(statSync(result.location.sockets).mode & 0o777, 0o700);
  rmSync(result.location.sockets, { recursive: true });
  symlinkSync(directory, result.location.sockets);
  assert.throws(() => {
    result.ensureSocketDirectory();
  }, /is not a directory/);
});

test("registrations outside the socket directory are disabled and the rest stay", () => {
  const directory = root();
  const result = control(directory);
  mkdirSync(result.location.sockets, { recursive: true });
  const inside = result.state.register(
    "lima:inside",
    path.join(result.location.sockets, "github-aa.sock"),
    "tester",
  );
  const old = result.state.register(
    "lima:old",
    path.join(directory, "lima", "old", "sock", "github-bb.sock"),
    "tester",
  );
  const nested = result.state.register(
    "lima:nested",
    path.join(result.location.sockets, "sub", "github-cc.sock"),
    "tester",
  );
  const disabled = result.disableOutsideSocketDirectory();
  assert.deepEqual(
    disabled.map((instance) => instance.name).toSorted(compareCodeUnits),
    ["lima:nested", "lima:old"],
  );
  assert.equal(result.state.byId(old.id)?.disabled, true);
  assert.equal(result.state.byId(nested.id)?.disabled, true);
  assert.equal(result.state.byId(inside.id)?.disabled, false);
  assert.deepEqual(result.state.grants(old.id), {});
  assert.deepEqual(
    result.state
      .events(old.id)
      .map((event) => JSON.stringify(event.changes))
      .toSorted(compareCodeUnits),
    [
      JSON.stringify({ disabled: true, removed: {} }),
      JSON.stringify({ registered: true }),
    ],
  );
  assert.deepEqual(result.disableOutsideSocketDirectory(), []);
});

test("stale sockets are removed and nothing else is", () => {
  const directory = root();
  const result = control(directory);
  const { sockets } = result.location;
  mkdirSync(sockets, { recursive: true });
  const kept = path.join(sockets, "github-aa-11.sock");
  result.state.register("lima:kept", kept, "tester");
  const stale = path.join(sockets, "github-bb-22.sock");
  const folder = path.join(sockets, "github-cc-33.sock");
  const others = [
    "notes.txt",
    "github-aa-11.sock.bak",
    "github-ZZ.sock",
    "admin.sock",
  ].map((name) => path.join(sockets, name));
  for (const file of [kept, stale, ...others]) {
    writeFileSync(file, "");
  }
  mkdirSync(folder);
  assert.deepEqual(result.removeStaleSockets(), [stale]);
  assert.deepEqual(
    readdirSync(sockets).toSorted(compareCodeUnits),
    [kept, folder, ...others]
      .map((file) => path.basename(file))
      .toSorted(compareCodeUnits),
  );
});

test("a disabled registration's socket counts as stale", () => {
  const directory = root();
  const result = control(directory);
  const { sockets } = result.location;
  mkdirSync(sockets, { recursive: true });
  const file = path.join(sockets, "github-aa-11.sock");
  result.state.register("lima:gone", file, "tester");
  result.state.disable("lima:gone", "tester");
  writeFileSync(file, "");
  assert.deepEqual(result.removeStaleSockets(), [file]);
});

async function answeringFireworksKey(
  directory: string,
  reply: { status?: number; body: string },
): Promise<void> {
  const result = control(directory);
  mkdirSync(path.dirname(result.location.admin), { recursive: true });
  const server = http.createServer((request, response) => {
    response
      .writeHead(request.url === "/fireworks-key" ? (reply.status ?? 200) : 404)
      .end(reply.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(result.location.admin, resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
}

test("fireworksKey returns the three answers of the daemon", async () => {
  for (const answer of [
    { state: "missing", reason: null },
    { state: "usable", reason: null },
    { state: "unusable", reason: "is empty" },
  ]) {
    const directory = root();
    await answeringFireworksKey(directory, { body: JSON.stringify(answer) });
    assert.deepEqual(await control(directory).fireworksKey(), answer);
  }
});

test("fireworksKey says that a daemon which does not know the route is older than this cog, and fails when the daemon refuses or is absent", async () => {
  const directory = root();
  await answeringFireworksKey(directory, { status: 404, body: "" });
  await assert.rejects(
    control(directory).fireworksKey(),
    /the running gateway is older than this cog; run \.\/install\.sh/,
  );
  const refusing = root();
  await answeringFireworksKey(refusing, { status: 503, body: "" });
  await assert.rejects(
    control(refusing).fireworksKey(),
    /gateway administration failed/,
  );
  await assert.rejects(control(root()).fireworksKey());
});

test.each([
  ["text", "not json", /invalid JSON/],
  ["an array", "[]", /invalid Fireworks key state/],
  ["null", "null", /invalid Fireworks key state/],
  [
    "an unknown state",
    JSON.stringify({ state: "broken", reason: null }),
    /invalid Fireworks key state/,
  ],
  [
    "a reason with a usable key",
    JSON.stringify({ state: "usable", reason: "is empty" }),
    /invalid Fireworks key reason/,
  ],
  [
    "a reason with a missing file",
    JSON.stringify({ state: "missing", reason: "is empty" }),
    /invalid Fireworks key reason/,
  ],
  [
    "an unusable key without a reason",
    JSON.stringify({ state: "unusable", reason: null }),
    /invalid Fireworks key reason/,
  ],
  [
    "an unusable key with an empty reason",
    JSON.stringify({ state: "unusable", reason: "" }),
    /invalid Fireworks key reason/,
  ],
  [
    "an oversized answer",
    JSON.stringify({ state: "unusable", reason: "x".repeat(5000) }),
    /answer too big/,
  ],
] as const)(
  "fireworksKey rejects an answer with %s",
  async (_, body, message) => {
    const directory = root();
    await answeringFireworksKey(directory, { body });
    await assert.rejects(control(directory).fireworksKey(), message);
  },
);

// gateway.sb names the files that the daemon uses by pattern, and an
// unmatched name is an EPERM in production, which Linux CI cannot show.
const profile = readFileSync(
  path.join(import.meta.dirname, "gateway.sb"),
  "utf8",
);

function topLevelForms(text: string): string[] {
  const code = text.replaceAll(/;.*$/gmu, "");
  const forms: string[] = [];
  let depth = 0;
  let start = 0;
  for (const token of code.matchAll(/"(?:[^"\\]|\\.)*"|[()]/gu)) {
    switch (token[0]) {
      case "(": {
        if (depth === 0) {
          start = token.index;
        }
        depth++;
        break;
      }
      case ")": {
        depth--;
        if (depth === 0) {
          forms.push(code.slice(start, token.index + 1));
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  return forms;
}

function profilePatterns(
  head: string,
  parameter: string,
  directory: string,
): RegExp[] {
  const escaped = directory.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
  return topLevelForms(profile)
    .filter((form) => form.startsWith(head))
    .flatMap((form) =>
      [
        ...form.matchAll(
          /\(regex \(string-append "\^" \(regex-quote \(param "(\w+)"\)\) "((?:[^"\\]|\\.)*)"\)\)/gu,
        ),
      ].filter((match) => match[1] === parameter),
    )
    .map(
      (match) =>
        new RegExp(
          `^${escaped}${(match[2] ?? "").replaceAll("\\\\", "\\")}`,
          "u",
        ),
    );
}

// The last matching rule wins, and the deny follows the allows it narrows.
function permitted(
  parameter: string,
  directory: string,
  file: string,
): boolean {
  const allowed = profilePatterns(
    "(allow file-read* file-write*",
    parameter,
    directory,
  );
  const denied = profilePatterns(
    "(deny file-read* file-write*",
    parameter,
    directory,
  );
  return (
    allowed.some((pattern) => pattern.test(file)) &&
    denied.every((pattern) => !pattern.test(file))
  );
}

test("the profile admits the certificate files and work directories that the daemon makes", () => {
  const directory = root();
  const shims = root();
  const log = path.join(shims, "listing");
  const real = spawnSync("sh", ["-c", "command -v openssl"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    path.join(shims, "openssl"),
    `#!/bin/sh\nfind "${directory}" >>"${log}"\n"${real}" "$@"\nstatus=$?\nfind "${directory}" >>"${log}"\nexit $status\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  onTestFinished(() => {
    process.env.PATH = originalPath;
  });
  process.env.PATH = `${shims}:${originalPath ?? ""}`;
  ensureCertificates(directory);
  const listed = new Set(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((file) => file !== "" && file !== directory),
  );
  for (const name of readdirSync(directory)) {
    listed.add(path.join(directory, name));
  }
  assert.ok([...listed].includes(`${directory}/.lock`));
  assert.ok([...listed].some((file) => /\/\.issue-[^/]+\/[^/]+$/u.test(file)));
  assert.ok(listed.has(`${directory}/ca.srl`));
  for (const file of listed) {
    assert.ok(
      permitted("SECRETS", directory, file),
      `${file} is not permitted`,
    );
  }
});

interface Internals {
  file: (repository: string) => string;
  locked: (repository: string, work: () => void) => Promise<void>;
  save: (record: Record<string, unknown>) => void;
}

test("the profile admits the authorization records, temporaries and locks that the daemon makes", async () => {
  const directory = root();
  const auth = new AppAuth(directory) as unknown as Internals;
  const now = Math.floor(Date.now() / 1000);
  const names = new Set<string>();
  for (const repository of [
    "shields/cog",
    "a/b",
    `${"o".repeat(39)}/${"r".repeat(100)}`,
    "a.b_c-d/e.f_g-h",
  ]) {
    const file = auth.file(repository);
    names.add(file);
    await auth.locked(repository, () => {
      const lock = `${file}.lock`;
      assert.ok(readdirSync(directory).includes(path.basename(lock)));
      names.add(lock);
    });
    mkdirSync(file);
    let temporary = "";
    try {
      auth.save({
        client_id: "Iv-test",
        repository,
        access_token: "ghu_old",
        access_expires_at: now,
        refresh_token: "ghr_old",
        refresh_expires_at: now,
        web_url: "https://github.com",
        api_url: "https://api.github.com",
      });
    } catch (error) {
      temporary = (error as { path?: string }).path ?? "";
    }
    assert.match(temporary, /\.json\.\d+\.\d+\.tmp$/u);
    names.add(temporary);
    rmSync(file, { recursive: true });
  }
  for (const file of names) {
    assert.ok(
      permitted("SECRETS", directory, file),
      `${file} is not permitted`,
    );
  }
});

test("the profile refuses the files that only the CLI uses", () => {
  const directory = "/secrets";
  const tailscale = path.basename(loadConfig({ HOME: "/h" }).tailscaleFile);
  assert.equal(tailscale, "tailscale-oauth.json");
  for (const name of [
    tailscale,
    `${tailscale}.lock`,
    `${tailscale}.1.2.tmp`,
    "cloudflare-admin-token",
    ".cloudflare-admin-token.AbC123",
    "notes.txt",
    "claude-pool/new",
  ]) {
    assert.ok(
      !permitted("SECRETS", directory, path.join(directory, name)),
      `${name} is permitted`,
    );
  }
  assert.ok(
    permitted(
      "SECRETS",
      directory,
      path.join(directory, `${Buffer.from("o/r").toString("base64url")}.json`),
    ),
  );
});

test("the profile admits the database files and the socket names that the gateway makes", () => {
  const directory = root();
  const state = new State(directory);
  state.prune();
  try {
    const names = readdirSync(directory);
    assert.ok(names.includes("state.sqlite-wal"));
    for (const name of [...names, "state.sqlite-journal"]) {
      assert.ok(
        permitted("STATE", directory, path.join(directory, name)),
        `${name} is not permitted`,
      );
    }
  } finally {
    state.close();
  }
  const socket = `github-${randomUUID()}.sock`;
  assert.ok(socketName.test(socket));
  assert.ok(
    permitted("STATE", directory, path.join(directory, "sock", socket)),
  );
  const binds = profilePatterns(
    "(allow network-bind network-inbound",
    "STATE",
    directory,
  );
  assert.ok(
    binds.some((pattern) => pattern.test(`${directory}/sock/${socket}`)),
  );
  for (const name of ["sock/other.sock", "sock/github-ab.sock.txt", "evil"]) {
    assert.ok(
      binds.every((pattern) => !pattern.test(`${directory}/${name}`)),
      `${name} may be bound`,
    );
  }
  assert.ok(
    topLevelForms(profile).some(
      (form) =>
        form.includes(
          '(literal (string-append (param "STATE") "/admin.sock"))',
        ) && form.startsWith("(allow network-bind network-inbound"),
    ),
  );
  for (const name of [
    "sock/other.sock",
    "sock/github-ab.sock.txt",
    "evil",
    "state.sqlite2",
  ]) {
    assert.ok(
      !permitted("STATE", directory, path.join(directory, name)),
      `${name} is permitted`,
    );
  }
});

test("the profile's literal paths are the ones that the code names", () => {
  const where = locations({ COG_ROOT: "/r" });
  assert.equal(path.relative(where.state, where.admin), "admin.sock");
  assert.equal(path.relative(where.state, where.sockets), "sock");
  assert.equal(path.relative(where.secrets, where.pool), "claude-pool");
  const forms = topLevelForms(profile).map((form) =>
    form.replaceAll(/\s+/gu, " "),
  );
  const admin = '(literal (string-append (param "STATE") "/admin.sock"))';
  for (const head of [
    "(allow file-read* file-write*",
    "(allow network-bind network-inbound",
  ]) {
    assert.ok(
      forms.some((form) => form.startsWith(head) && form.includes(admin)),
      `${head} names the admin socket`,
    );
  }
  for (const rule of [
    '(allow file-read* file-write-mode file-write-create (literal (string-append (param "STATE") "/sock")))',
    '(allow file-read* file-write-mode (literal (param "STATE")) (literal (param "SECRETS")))',
    '(allow file-read* (subpath (string-append (param "SECRETS") "/claude-pool")))',
    '(allow file-read* (literal (param "FIREWORKS_KEY")))',
  ]) {
    assert.ok(forms.includes(rule), rule);
  }
});
