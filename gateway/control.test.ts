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
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    secrets: "/r/secrets",
    admin: "/r/state/admin.sock",
  });
  assert.deepEqual(locations({ HOME: "/h" }), {
    state: "/h/.local/state/cog",
    secrets: "/h/.config/secrets/cog",
    admin: "/h/.local/state/cog/admin.sock",
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

test("register checks the directory before it touches anything", async () => {
  const directory = root();
  const result = control(directory);
  await assert.rejects(
    result.register("lima:t1", "relative/dir"),
    /Lima instance directory must be absolute/,
  );
  await assert.rejects(
    result.register("lima:t1", `/${"x".repeat(120)}`),
    /VM path is too long for a Unix socket/,
  );
  assert.equal(existsSync(path.join(directory, "state")), false);
});

test("register is undone when the daemon cannot be told", async () => {
  const directory = root();
  const lima = path.join(directory, "lima");
  mkdirSync(lima, { recursive: true });
  const result = control(directory);
  await assert.rejects(result.register("lima:t1", lima));
  assert.equal(result.state.byName("lima:t1"), null);
  assert.deepEqual(result.state.active(), []);
  const [row] = result.state.db
    .prepare("SELECT id, socket, disabled FROM instances")
    .all() as unknown as { id: string; socket: string; disabled: number }[];
  assert.ok(row);
  assert.equal(row.disabled, 1);
  assert.match(row.socket, /\/lima\/sock\/github-[0-9a-f-]{36}\.sock$/);
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
