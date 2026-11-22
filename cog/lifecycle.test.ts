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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { claudeToken, grant, list, remove } from "./commands/lifecycle.ts";
import { newVM } from "./commands/new.ts";
import { loadConfig } from "./config.ts";
import { CommandFailed, Interrupted } from "./errors.ts";
import { signals } from "./proc.ts";

function home(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cog-lifecycle-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixture() {
  const config = loadConfig({ HOME: home(), COG_BASE: "base", COG_CPUS: "2" });
  const calls: unknown[][] = [];
  const mark = (method: string, ...args: unknown[]): void => {
    calls.push([method, ...args]);
  };
  const directory = path.join(config.home, "lima", "vm");
  const id = "12345678-0000-4000-8000-123456789abc";
  const socket = path.join(directory, "sock", `github-${id}.sock`);
  const ca = path.join(config.home, "ca.pem");
  const failures = {
    stopAt: "",
    signal: "SIGTERM" as "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM",
    disableFails: false,
    interruptCleanup: false,
  };
  const boundary = (stage: string): void => {
    if (failures.stopAt === stage) {
      process.emit(failures.signal, failures.signal);
    }
  };
  const context: Parameters<typeof newVM>[1] = {
    config,
    prompt: (input, hint) => {
      mark("prompt", input, hint);
      return Promise.resolve("fake-claude");
    },
    lima: {
      exists: (name) => {
        mark("exists", name);
        return Promise.resolve(name === config.base);
      },
      clone: (base, name, size) => {
        mark("clone", base, name, size);
        return Promise.resolve();
      },
      directory: (name) => {
        mark("directory", name);
        return Promise.resolve(directory);
      },
      edit: (name, rule) => {
        mark("edit", name, rule);
        return Promise.resolve();
      },
      boot: (name) => {
        mark("boot", name);
        return Promise.resolve();
      },
      guestHome: (name) => {
        mark("guestHome", name);
        return Promise.resolve("/home/guest");
      },
      remove: (name) => {
        signals.check();
        mark("remove", name);
        return Promise.resolve();
      },
      shell: (name, argv, options) => {
        mark("shell", name, argv, options?.stdin ?? null);
        if (failures.stopAt === "upgrade-error" && argv[1] === "upgrade") {
          return Promise.reject(new CommandFailed("limactl shell", 7));
        }
        boundary(argv[1] ?? "");
        signals.check();
        return Promise.resolve();
      },
      enter: (name, workdir) => {
        mark("enter", name, workdir);
        return Promise.resolve(17);
      },
    },
    gateway: () => ({
      health: () => {
        mark("health");
        return Promise.resolve();
      },
      ensureAuth: (repository) => {
        mark("ensureAuth", repository);
        return Promise.resolve();
      },
      register: (name, instanceDirectory) => {
        mark(
          "register",
          name,
          instanceDirectory,
          statSync(path.dirname(socket)).mode & 0o777,
        );
        boundary("register");
        return Promise.resolve({
          name,
          id,
          socket,
          revision: 0,
          disabled: false,
        });
      },
      certificates: () => {
        mark("certificates");
        return { ca, key: "unused", cert: "unused" };
      },
      grant: (name, repository, profile) => {
        mark("grant", name, repository, profile().pushCogBranches);
        return Promise.resolve(1);
      },
      disable: (name) => {
        mark("disable", name);
        if (failures.interruptCleanup) {
          process.emit("SIGHUP", "SIGHUP");
        }
        return failures.disableFails
          ? Promise.reject(new Error("cannot sync"))
          : Promise.resolve();
      },
      close: () => {
        mark("close");
      },
    }),
  };
  return { calls, mark, context, id, socket, directory, ca, failures };
}

test("list only calls Lima and rm disables the gateway before deleting", async () => {
  const { calls, mark, context } = fixture();
  await list([], {
    ...context,
    lima: {
      list: () => {
        mark("list");
        return Promise.resolve();
      },
    },
  });
  await remove(["vm"], context);
  assert.deepEqual(calls, [["list"], ["disable", "lima:vm"], ["remove", "vm"]]);
});

test("rm does not delete if disable fails and refuses both base names", async () => {
  const { calls, context, failures } = fixture();
  for (const name of ["base", "cog-base"]) {
    await assert.rejects(remove([name], context), /refusing to delete/);
  }
  failures.disableFails = true;
  await assert.rejects(remove(["vm"], context), /cannot sync/);
  assert.deepEqual(calls, [["disable", "lima:vm"]]);
});

test("claude-token writes the prompted bytes to a private file and does not prompt for a directory", async () => {
  const { calls, context } = fixture();
  await claudeToken([], context);
  assert.equal(
    readFileSync(context.config.claudeTokenFile, "utf8"),
    "fake-claude\n",
  );
  assert.equal(statSync(context.config.claudeTokenFile).mode & 0o777, 0o600);
  assert.equal(
    statSync(path.dirname(context.config.claudeTokenFile)).mode & 0o777,
    0o700,
  );
  rmSync(context.config.claudeTokenFile);
  mkdirSync(context.config.claudeTokenFile);
  await assert.rejects(claudeToken([], context), /is not a regular file/);
  assert.deepEqual(calls, [["prompt", "", undefined]]);
});

test("grant validates the VM and applies the selected profile", async () => {
  const { calls, context, mark } = fixture();
  await assert.rejects(
    grant(["vm", "owner/repo"], context),
    /vm does not exist/,
  );
  const running = {
    ...context,
    lima: {
      exists: (name: string) => {
        mark("exists", name);
        return Promise.resolve(true);
      },
    },
  };
  await grant(["vm", "owner/repo", "--profile", "read"], running);
  await grant(["vm", "owner/repo"], running);
  await assert.rejects(
    grant(["vm", "owner/repo", "--profile=other"], running),
    /usage: cog grant/,
  );
  assert.deepEqual(calls, [
    ["exists", "vm"],
    ["exists", "vm"],
    ["grant", "lima:vm", "owner/repo", false],
    ["exists", "vm"],
    ["grant", "lima:vm", "owner/repo", true],
  ]);
});

test("new checks and authorizes before the clone and writes all inputs only after upgrade", async () => {
  const { calls, context, directory, ca, id } = fixture();
  const { codexAuthFile, fireworksKeyFile } = context.config;
  mkdirSync(path.dirname(codexAuthFile), { recursive: true });
  mkdirSync(path.dirname(fireworksKeyFile), { recursive: true });
  const codex = '{"auth":"fake-codex"}\n';
  writeFileSync(codexAuthFile, codex);
  writeFileSync(fireworksKeyFile, " fake-fireworks \n");
  const result = await newVM(["vm", "--repo=owner/repo"], context);
  assert.equal(result, 17);
  const guest = "/home/guest/src/github.com/owner/repo";
  const curl = ["curl", "--fail", "--silent", "--show-error", "--max-time"];
  const output = ["--noproxy", "*", "--output", "/dev/null"];
  assert.deepEqual(calls, [
    ["health"],
    ["exists", "base"],
    ["exists", "vm"],
    ["prompt", "", ", run cog claude-token once, or pass --no-claude-token"],
    ["ensureAuth", "owner/repo"],
    ["clone", "base", "vm", ["--cpus", "2"]],
    ["directory", "vm"],
    ["register", "lima:vm", directory, 0o700],
    [
      "edit",
      "vm",
      `.portForwards = [{"guestSocket":"/tmp/cog-github.sock","hostSocket":"{{.Dir}}/sock/github-${id}.sock","reverse":true}] + .portForwards`,
    ],
    ["boot", "vm"],
    [
      "shell",
      "vm",
      [
        "/home/linuxbrew/.linuxbrew/bin/brew",
        "upgrade",
        "--cask",
        "claude-code@latest",
        "codex",
      ],
      null,
    ],
    ["guestHome", "vm"],
    ["certificates"],
    [
      "shell",
      "vm",
      ["sudo", "/usr/local/lib/cog/setup-github-gateway", id],
      { file: ca },
    ],
    [
      "shell",
      "vm",
      [...curl, "10", ...output, "https://api.github.com/__cog__/health"],
      null,
    ],
    ["grant", "lima:vm", "owner/repo", true],
    [
      "shell",
      "vm",
      [...curl, "20", ...output, "https://api.github.com/repos/owner/repo"],
      null,
    ],
    [
      "shell",
      "vm",
      [
        "env",
        "GIT_TERMINAL_PROMPT=0",
        "git",
        "clone",
        "--quiet",
        "https://github.com/owner/repo.git",
        guest,
      ],
      null,
    ],
    ...[
      ["CLAUDE_CODE_OAUTH_TOKEN", "fake-claude\n"],
      ["CODEX_AUTH", codex],
      ["FIREWORKS_API_KEY", "fake-fireworks\n"],
    ].map(([key, value]) => [
      "shell",
      "vm",
      ["/usr/local/lib/cog/setup-secrets", key],
      new TextEncoder().encode(value),
    ]),
    ["close"],
    ["enter", "vm", guest],
  ]);
});

const noSecrets = ["vm", "--no-repo", "--no-claude-token", "--no-codex-auth"];

test("new does not ask, authorize or clone when the Codex file fails validation", async () => {
  const { calls, context } = fixture();
  const codex = context.config.codexAuthFile;
  mkdirSync(path.dirname(codex), { recursive: true });
  writeFileSync(codex, 'not-json-"private-marker"');
  await assert.rejects(newVM(["vm", "--repo", "owner/repo"], context), {
    message: `${codex} is not a JSON object; run codex login on this Mac again, or pass --no-codex-auth`,
  });
  assert.deepEqual(calls, [["health"], ["exists", "base"], ["exists", "vm"]]);
});

test("an upgrade failure sends no inputs and keeps its status through a hangup during cleanup", async () => {
  const { calls, context, failures } = fixture();
  failures.stopAt = "upgrade-error";
  failures.interruptCleanup = true;
  await assert.rejects(newVM(noSecrets, context), { status: 7 });
  assert.deepEqual(calls.slice(-2), [
    ["disable", "lima:vm"],
    ["remove", "vm"],
  ]);
  assert.equal(calls.filter(([method]) => method === "shell").length, 1);
});

test.each([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
] as const)(
  "%s received mid-registration disables and deletes the VM",
  async (signal, status) => {
    const { calls, context, failures } = fixture();
    failures.stopAt = "register";
    failures.signal = signal;
    failures.disableFails = true;
    await assert.rejects(
      newVM(noSecrets, context),
      (error: unknown) =>
        error instanceof Interrupted && error.status === status,
    );
    assert.deepEqual(calls.slice(-2), [
      ["disable", "lima:vm"],
      ["remove", "vm"],
    ]);
    assert.equal(
      calls.some(([method]) => method === "edit"),
      false,
    );
  },
);
