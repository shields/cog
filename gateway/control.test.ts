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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import {
  Control,
  controlOptions,
  locations,
  parseEdit,
  policyDocument,
} from "./control.ts";
import { compareCodeUnits, type Grant } from "./policy.ts";

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
  await assert.rejects(
    result.register("lima:t1"),
    /the state directory is too long for a Unix socket/,
  );
  assert.deepEqual(readdirSync(directory), []);
});

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
