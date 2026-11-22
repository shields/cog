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
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import YAML from "yaml";
import {
  Control,
  controlOptions,
  locations,
  parseProfiles,
  profileNamed,
} from "../gateway/control.ts";
import { State } from "../gateway/state.ts";

const main = path.join(import.meta.dirname, "main.ts");

function profiles(): string {
  return readFileSync(
    path.join(import.meta.dirname, "../profiles.yaml"),
    "utf8",
  );
}

test("CLI grants and edits apply live and disabled VM logs stay addressable by ID", async () => {
  const root = mkdtempSync("/tmp/cog-");
  const lima = path.join(root, "lima");
  const secrets = path.join(root, "secrets");
  mkdirSync(path.join(lima, "sock"), { recursive: true });
  mkdirSync(secrets);
  const repository = "shields/dotfiles";
  writeFileSync(
    path.join(secrets, `${Buffer.from(repository).toString("base64url")}.json`),
    JSON.stringify({
      client_id: "Iv-test",
      repository,
      access_token: "ghu_test",
      access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "ghr_test",
      refresh_expires_at: Math.floor(Date.now() / 1000) + 86_400,
      web_url: "https://github.com",
      api_url: "https://api.github.com",
    }),
  );
  const environment = { ...process.env, COG_ROOT: root };
  const bundle = path.join(root, "main.mjs");
  const build = spawnSync(
    process.execPath,
    ["build", main, "--target=bun", "--outfile", bundle],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(build.status, 0, build.stderr);
  const service = spawn(process.execPath, [bundle, "gateway", "serve"], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serviceError = "";
  service.stderr.on("data", (chunk: Buffer) => {
    serviceError += chunk.toString();
  });
  const call = (args: string[], extra: NodeJS.ProcessEnv = {}): string => {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      env: { ...environment, ...extra },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const control = new Control(locations(environment), {
    ...controlOptions(environment),
    actor: "tester",
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 600 && !healthy; attempt++) {
      try {
        await control.health();
        healthy = true;
      } catch {
        if (service.exitCode !== null || service.signalCode !== null) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
    assert.equal(healthy, true, serviceError);
    assert.equal(call(["gateway", "health"]), "ready\n");
    assert.equal(
      statSync(path.join(root, "state", "admin.sock")).mode & 0o077,
      0,
    );
    const instance = await control.register("lima:trial", lima);
    assert.match(instance.id, /^[0-9a-f-]{36}$/);
    assert.match(instance.socket, /\/sock\/github-[0-9a-f-]{36}\.sock$/);
    assert.equal(
      await control.grant("lima:trial", repository, () =>
        profileNamed(parseProfiles(profiles()), "cog"),
      ),
      1,
    );
    control.close();
    assert.match(call(["show", "trial"]), /revision: 1/);
    const initial = YAML.parse(call(["show", "trial"])) as {
      vm: string;
      repositories: Record<string, { pushCogBranches: boolean }>;
    };
    assert.equal(initial.vm, "lima:trial");
    assert.equal(initial.repositories[repository]?.pushCogBranches, true);
    const editor = path.join(root, "editor");
    writeFileSync(
      editor,
      '#!/bin/sh\nset -eu\nsed \'s/pushCogBranches: true/pushCogBranches: false/\' "$1" > "$1.tmp"\nmv "$1.tmp" "$1"\n',
    );
    chmodSync(editor, 0o700);
    assert.match(
      call(["edit", "trial"], { EDITOR: editor, VISUAL: editor }),
      /revision 2/,
    );
    const edited = YAML.parse(call(["show", "trial"])) as {
      repositories: Record<string, { pushCogBranches: boolean }>;
    };
    assert.equal(edited.repositories[repository]?.pushCogBranches, false);
    assert.match(call(["revoke", "trial", repository]), /revision 3/);
    assert.deepEqual(
      (YAML.parse(call(["show", "trial"])) as { repositories: object })
        .repositories,
      {},
    );
    assert.equal(call(["gateway", "disable", "trial"]), "");
    const state = new State(path.join(root, "state"));
    try {
      for (let index = 0; index < 101; index++) {
        state.logDecision({
          id: `request-${String(index)}`,
          instanceId: instance.id,
          repository,
          operation: "git.read",
          refs: [],
          allowed: true,
          reason: "granted",
          revision: 2,
        });
      }
    } finally {
      state.close();
    }
    assert.equal(call(["logs", instance.id]).trim().split("\n").length, 105);
    const history = call(["logs", instance.id, "--all"])
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; vm: string });
    assert.equal(history.length, 106);
    assert.ok(history.every((entry) => entry.vm === "lima:trial"));
    assert.equal(history.filter((entry) => entry.kind === "policy").length, 5);
  } finally {
    control.close();
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

interface Sandbox {
  root: string;
  ghCalls: string;
  run: (args: string[], extra?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
}

// gh records its arguments and fails, so reaching GitHub authorization shows
// up as a call.
function sandbox(): Sandbox {
  const root = mkdtempSync("/tmp/cog-");
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "bin");
  const ghCalls = path.join(root, "gh-calls");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\necho "$*" >> ${ghCalls}\nexit 1\n`,
    { mode: 0o700 },
  );
  const state = new State(path.join(root, "state"));
  try {
    state.register("lima:trial", path.join(root, "trial.sock"), "tester");
  } finally {
    state.close();
  }
  return {
    root,
    ghCalls,
    run: (args, extra = {}) =>
      spawnSync(process.execPath, [main, ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          COG_ROOT: root,
          ...extra,
        },
        encoding: "utf8",
        timeout: 30_000,
      }),
  };
}

function repositoriesEditor(root: string): string {
  const editor = path.join(root, "editor");
  writeFileSync(
    editor,
    '#!/bin/sh\nset -eu\nsed "/^repositories:/,\\$d" "$1" > "$1.tmp"\nprintf "repositories: %s\\n" "$REPOSITORIES" >> "$1.tmp"\nmv "$1.tmp" "$1"\n',
    { mode: 0o700 },
  );
  return editor;
}

test("edit rejects an invalid policy before it authorizes anything", () => {
  const { root, ghCalls, run } = sandbox();
  const editor = repositoriesEditor(root);
  const valid = "{read: true, pushCogBranches: false}";
  for (const [repositories, message] of [
    [
      "{shields/new: {read: true, pushCogBranches: maybe}}",
      "invalid grant for shields/new",
    ],
    [
      `{shields/new: ${valid}, Shields/New: ${valid}}`,
      "duplicate repository Shields/New",
    ],
    [`{"not a repository": ${valid}}`, "repository must be OWNER/REPO"],
    ["null", "repositories must be a mapping"],
    ["5", "repositories must be a mapping"],
    ["[]", "repositories must be a mapping"],
  ] as const) {
    const result = run(["edit", "trial"], {
      EDITOR: editor,
      VISUAL: editor,
      REPOSITORIES: repositories,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `cog: ${message}\n`);
  }
  assert.equal(existsSync(ghCalls), false);
});

test("edit keeps the grants when repositories is a set, an ordered map, or a timestamp", () => {
  const { root, ghCalls, run } = sandbox();
  const read = { read: true, pushCogBranches: false };
  const seeded = new State(path.join(root, "state"));
  try {
    seeded.update("lima:trial", 0, { "shields/dotfiles": read }, "tester");
  } finally {
    seeded.close();
  }
  const editor = repositoriesEditor(root);
  for (const repositories of [
    "!!set {shields/dotfiles}",
    "!!omap [{shields/dotfiles: {read: true, pushCogBranches: false}}]",
    "!!timestamp 2001-12-14",
  ]) {
    const result = run(["edit", "trial"], {
      EDITOR: editor,
      VISUAL: editor,
      REPOSITORIES: repositories,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, "cog: repositories must be a mapping\n");
  }
  const state = new State(path.join(root, "state"));
  try {
    const instance = state.byName("lima:trial");
    assert.ok(instance);
    assert.equal(instance.revision, 1);
    assert.deepEqual(state.grants(instance.id), { "shields/dotfiles": read });
  } finally {
    state.close();
  }
  assert.equal(existsSync(ghCalls), false);
});

test("edit authorizes a repository it adds", () => {
  const { root, ghCalls, run } = sandbox();
  const editor = repositoriesEditor(root);
  const result = run(["edit", "trial"], {
    EDITOR: editor,
    VISUAL: editor,
    REPOSITORIES: "{shields/new: {read: true, pushCogBranches: false}}",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stderr,
    "cog: gh cannot read shields/new; check the repository and your Mac gh login\n",
  );
  assert.equal(
    readFileSync(ghCalls, "utf8"),
    "api repos/shields/new --jq .id\n",
  );
});

test("edit leaves the policy alone when the editor fails, and removes its file", () => {
  const { root, run } = sandbox();
  const editor = path.join(root, "failing-editor");
  writeFileSync(editor, '#!/bin/sh\nprintf %s "$1" > "$0.file"\nexit 3\n', {
    mode: 0o700,
  });
  const result = run(["edit", "trial"], { EDITOR: editor, VISUAL: editor });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "cog: editor failed; policy is unchanged\n");
  const file = readFileSync(`${editor}.file`, "utf8");
  assert.match(file, /\/cog-edit-[^/]+\/policy\.yaml$/);
  assert.equal(existsSync(path.dirname(file)), false);
});

test("the gateway verbs take bare names and refuse the other spelling", () => {
  const { run } = sandbox();
  for (const args of [
    ["show", "lima:trial"],
    ["edit", "lima:trial"],
    ["revoke", "lima:trial", "shields/dotfiles"],
    ["gateway", "disable", "lima:trial"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stderr, "cog: invalid VM name: lima:trial\n");
  }
});

test("a VM that is not registered is reported by its gateway name", () => {
  const { run } = sandbox();
  for (const args of [
    ["show", "other"],
    ["revoke", "other", "shields/dotfiles"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "cog: lima:other is not a registered VM\n");
  }
  const logs = run(["logs", "other"]);
  assert.equal(logs.status, 1);
  assert.equal(logs.stderr, "cog: other is not a known VM\n");
});

test("revoke names a grant that is not there", () => {
  const { run } = sandbox();
  const result = run(["revoke", "trial", "shields/dotfiles"]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "cog: shields/dotfiles is not granted to lima:trial\n",
  );
});

test("usage errors name the command and exit 1", () => {
  const { run } = sandbox();
  for (const [args, usage] of [
    [["show"], "usage: cog show NAME"],
    [["show", "a", "b"], "usage: cog show NAME"],
    [["edit"], "usage: cog edit NAME"],
    [["revoke", "a"], "usage: cog revoke NAME OWNER/REPO"],
    [["logs"], "usage: cog logs NAME|VM-ID [--follow|--all]"],
    [["logs", "a", "--tail"], "usage: cog logs NAME|VM-ID [--follow|--all]"],
    [["authorize"], "usage: cog authorize OWNER/REPO"],
    [["gateway"], "usage: cog gateway serve|health|disable NAME"],
    [["gateway", "serve", "x"], "usage: cog gateway serve"],
    [["gateway", "health", "x"], "usage: cog gateway health"],
    [["gateway", "disable"], "usage: cog gateway disable NAME"],
    [["gateway", "init"], "usage: cog gateway serve|health|disable NAME"],
  ] as const) {
    const result = run([...args]);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stderr, `cog: ${usage}\n`);
    assert.equal(result.stdout, "");
  }
});

test("no command, or an unknown one, prints the usage to stderr and exits 2", () => {
  const { run } = sandbox();
  for (const args of [
    [],
    ["frobnicate"],
    ["register"],
    ["ca-path"],
    ["github"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^usage: cog base \[--dotfiles DIR\] \[MODULE\.\.\.\]\n/,
    );
  }
});

test("help prints the usage to stdout and exits 0", () => {
  const { run } = sandbox();
  for (const word of ["help", "-h", "--help"]) {
    const result = run([word]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^usage: cog base /);
    assert.match(result.stdout, /cog gateway serve\|health\|disable NAME/);
    assert.match(result.stdout, /cog-base/);
  }
  const renamed = run(["help"], { COG_BASE: "other-base" });
  assert.match(renamed.stdout, /build other-base from/);
});

test("HOME is required, even by help", () => {
  const { root } = sandbox();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "HOME"),
  );
  const result = spawnSync(process.execPath, [main, "help"], {
    env: { ...environment, COG_ROOT: root },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "cog: HOME is not set\n");
});

test("an invalid COG_BASE is refused before anything runs", () => {
  const { run } = sandbox();
  const result = run(["help"], { COG_BASE: "not a name" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "cog: invalid VM name: not a name\n");
});

test("verbs that are not ported yet say so", () => {
  const { run } = sandbox();
  for (const verb of ["base", "new", "grant", "claude-token", "rm", "list"]) {
    const result = run([verb]);
    assert.equal(result.status, 1, verb);
    assert.equal(result.stderr, `cog: ${verb} is not implemented yet\n`);
  }
});

test("help creates no state, and a command that needs the gateway creates it privately under any umask", () => {
  const { root } = sandbox();
  const fresh = path.join(root, "fresh");
  const run = (args: string[]): SpawnSyncReturns<string> =>
    spawnSync(
      "/bin/sh",
      ["-c", 'umask 000; exec "$@"', "sh", process.execPath, main, ...args],
      {
        env: { ...process.env, COG_ROOT: fresh },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  assert.equal(run(["help"]).status, 0);
  assert.equal(existsSync(fresh), false);
  assert.equal(run(["show", "nobody"]).status, 1);
  const state = path.join(fresh, "state");
  assert.equal(statSync(state).mode & 0o777, 0o700);
  const files = readdirSync(state);
  assert.ok(files.includes("state.sqlite"));
  for (const file of files) {
    assert.equal(statSync(path.join(state, file)).mode & 0o077, 0, file);
  }
  assert.equal(existsSync(path.join(fresh, "secrets")), false);
});

test("serve closes the listeners it opened and exits when it cannot open one for a registered VM", () => {
  const { root, run } = sandbox();
  const state = new State(path.join(root, "state"));
  try {
    // The listener for lima:trial is already open when this one fails.
    state.register(
      "lima:vanished",
      path.join(root, "vanished", "vanished.sock"),
      "tester",
    );
  } finally {
    state.close();
  }
  const result = run(["gateway", "serve"]);
  assert.deepEqual(
    { status: result.status, signal: result.signal },
    { status: 1, signal: null },
    result.stderr,
  );
  assert.match(
    result.stderr,
    /^cog: [^\n]*ENOENT[^\n]*vanished\.sock[^\n]*\n$/,
  );
}, 60_000);
