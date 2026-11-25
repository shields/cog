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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, spyOn, test } from "bun:test";
import { Control, locations } from "../gateway/control.ts";
import { State } from "../gateway/state.ts";
import { grant, list, remove } from "./commands/lifecycle.ts";
import { newVM } from "./commands/new.ts";
import { loadConfig } from "./config.ts";
import { CommandFailed, Interrupted } from "./errors.ts";
import { signals } from "./proc.ts";
import {
  configureTailscale,
  enrollTailscale,
  tailscaleCredential,
} from "./tailscale.ts";

function home(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cog-lifecycle-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixture() {
  const config = loadConfig({ HOME: home(), COG_BASE: "base", COG_CPUS: "2" });
  const state = new State(path.join(config.home, "state"));
  onTestFinished(() => {
    state.close();
  });
  const calls: unknown[][] = [];
  const mark = (method: string, ...args: unknown[]): void => {
    calls.push([method, ...args]);
  };
  const location = locations({ COG_ROOT: config.home });
  const id = "12345678-0000-4000-8000-123456789abc";
  const socket = path.join(location.sockets, `github-${id}.sock`);
  const ca = path.join(config.home, "ca.pem");
  const failures = {
    stopAt: "",
    signal: "SIGTERM" as "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM",
    disableFails: false,
    interruptCleanup: false,
    pool: "usable" as "unconfigured" | "unusable" | "usable" | "old",
    probeFails: "",
    syncFails: false,
  };
  const boundary = (stage: string): void => {
    if (failures.stopAt === stage) {
      process.emit(failures.signal, failures.signal);
    }
  };
  const context: Parameters<typeof newVM>[1] & Parameters<typeof remove>[1] = {
    config,
    lima: {
      hasGatewaySocket: () =>
        Promise.reject(new Error("unexpected socket query")),
      exists: (name) => {
        mark("exists", name);
        return Promise.resolve(name === config.base);
      },
      clone: (base, name, size) => {
        mark("clone", base, name, size);
        return Promise.resolve();
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
        if (failures.probeFails !== "" && argv.at(-1) === failures.probeFails) {
          return Promise.reject(new CommandFailed("limactl shell", 1));
        }
        boundary(argv[1] ?? "");
        signals.check();
        return Promise.resolve();
      },
      shellOutput: () => Promise.reject(new Error("unexpected shell query")),
      enter: (name, workdir) => {
        mark("enter", name, workdir);
        return Promise.resolve(17);
      },
    },
    gateway: () => ({
      state,
      location,
      health: () => {
        mark("health");
        return Promise.resolve();
      },
      sync: () => {
        mark("sync");
        return failures.syncFails
          ? Promise.reject(new Error("gateway administration failed"))
          : Promise.resolve();
      },
      pool: () => {
        mark("pool");
        if (failures.pool === "old") {
          return Promise.reject(
            new Error(
              "the running gateway is older than this cog; run ./install.sh in the cog checkout",
            ),
          );
        }
        return Promise.resolve({
          state: failures.pool,
          reason:
            failures.pool === "unusable" ? "account work is broken" : null,
          accounts: [],
        });
      },
      prepareRepository: (repository) => {
        mark("prepareRepository", repository);
        return Promise.resolve("authenticated");
      },
      register: (name) => {
        mark("register", name);
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
        mark("grant", name, repository, profile.pushCogBranches);
        return Promise.resolve(1);
      },
      disable: (name) => {
        mark("disable", name);
        if (failures.interruptCleanup) {
          process.emit("SIGHUP", "SIGHUP");
        }
        return failures.disableFails
          ? Promise.reject(new Error("cannot sync"))
          : Promise.resolve(null);
      },
      close: () => {
        mark("close");
      },
    }),
  };
  return { calls, mark, context, id, socket, ca, failures };
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

test("new authorizes a private repository before cloning and grants only reads", async () => {
  const { calls, context, socket, ca, id } = fixture();
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
    ["sync"],
    ["pool"],
    ["prepareRepository", "owner/repo"],
    ["clone", "base", "vm", ["--cpus", "2"]],
    ["register", "lima:vm"],
    [
      "edit",
      "vm",
      `.portForwards = [{"guestSocket":"/tmp/cog-github.sock","hostSocket":${JSON.stringify(socket)},"reverse":true}] + .portForwards`,
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
    [
      "shell",
      "vm",
      ["sudo", "/usr/local/lib/cog/setup-model-gateway", "claude", "fireworks"],
      null,
    ],
    [
      "shell",
      "vm",
      [...curl, "10", ...output, "https://api.anthropic.com/__cog__/health"],
      null,
    ],
    [
      "shell",
      "vm",
      [...curl, "10", ...output, "https://api.fireworks.ai/__cog__/health"],
      null,
    ],
    ["grant", "lima:vm", "owner/repo", false],
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
      ["CLAUDE_CODE_OAUTH_TOKEN", "cog\n"],
      ["CODEX_AUTH", codex],
      ["FIREWORKS_API_KEY", "cog\n"],
    ].map(([key, value]) => [
      "shell",
      "vm",
      ["/usr/local/lib/cog/setup-secrets", key],
      new TextEncoder().encode(value),
    ]),
    ["close"],
    ["enter", "vm", guest],
  ]);
  const everything = JSON.stringify(calls, (_, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );
  assert.equal(everything.includes("fake-fireworks"), false);
});

function fireworksFixture(content: string | null, link = false) {
  const made = fixture();
  const file = made.context.config.fireworksKeyFile;
  mkdirSync(path.dirname(file), { recursive: true });
  if (link) {
    symlinkSync(path.join(path.dirname(file), "missing"), file);
  } else if (content !== null) {
    writeFileSync(file, content);
  }
  return made;
}

const wiring = (calls: unknown[][]): string[][] =>
  calls
    .filter(
      ([method, , argv]) =>
        method === "shell" &&
        (argv as string[]).some((word) =>
          /setup-model-gateway|__cog__\/health/.test(word),
        ),
    )
    .map((call) => (call[2] as string[]).filter((word) => word !== "sudo"));

test("new wires only Fireworks when --no-claude-token is given with a key file", async () => {
  const { calls, context } = fireworksFixture("fake-fireworks\n");
  await newVM(noSecrets, context);
  const lines = wiring(calls).map((argv) => argv.at(-1));
  assert.deepEqual(lines, [
    "https://api.github.com/__cog__/health",
    "fireworks",
    "https://api.fireworks.ai/__cog__/health",
  ]);
  const secrets = calls
    .filter(([method]) => method === "shell")
    .filter((call) => (call[2] as string[])[0]?.endsWith("setup-secrets"));
  assert.deepEqual(
    secrets.map((call) => [
      (call[2] as string[])[1],
      new TextDecoder().decode(call[3] as Uint8Array),
    ]),
    [["FIREWORKS_API_KEY", "cog\n"]],
  );
});

test("new wires nothing for Fireworks without a key file", async () => {
  const { calls, context } = fireworksFixture(null);
  await newVM(["vm", "--no-repo", "--no-codex-auth"], context);
  const text = JSON.stringify(calls);
  assert.equal(text.includes("fireworks"), false);
  assert.equal(text.includes("FIREWORKS"), false);
});

test.each([
  ["two words", "fake-fireworks other\n", "holds more than one word"],
  ["empty", "\n", "is empty"],
  [
    "not ASCII",
    "fake-fireworks\u{E9}\n",
    "holds a character that is not visible ASCII",
  ],
  ["too large", "k".repeat(4097), "is larger than 4096 bytes"],
] as const)(
  "a Fireworks key file that is %s fails before any VM work without quoting it",
  async (_, content, reason) => {
    const { calls, context } = fireworksFixture(content);
    const file = context.config.fireworksKeyFile;
    await assert.rejects(
      newVM(["vm", "--repo", "owner/repo", "--no-codex-auth"], context),
      {
        message: `${file} ${reason}; fix it or remove it`,
      },
    );
    assert.deepEqual(calls, [["health"], ["exists", "base"], ["exists", "vm"]]);
  },
);

test("a dangling Fireworks key link fails before any VM work", async () => {
  const { calls, context } = fireworksFixture(null, true);
  await assert.rejects(
    newVM(["vm", "--repo", "owner/repo", "--no-codex-auth"], context),
    {
      message: `${context.config.fireworksKeyFile} is not a regular file; remove it`,
    },
  );
  assert.deepEqual(calls, [["health"], ["exists", "base"], ["exists", "vm"]]);
});

test("a failure of the Fireworks probe names Fireworks and rolls back", async () => {
  const { calls, context, failures } = fireworksFixture("fake-fireworks\n");
  failures.probeFails = "https://api.fireworks.ai/__cog__/health";
  await assert.rejects(newVM(noSecrets, context), {
    message:
      "vm cannot reach Fireworks through the gateway; a base built by an older cog lacks this wiring, so run cog base again, or the running gateway is older than this cog, so run ./install.sh",
  });
  assert.deepEqual(calls.slice(-2), [
    ["disable", "lima:vm"],
    ["remove", "vm"],
  ]);
});

test("a failure of the Fireworks probe with Claude wired names both models and both causes", async () => {
  const { calls, context, failures } = fireworksFixture("fake-fireworks\n");
  failures.probeFails = "https://api.fireworks.ai/__cog__/health";
  await assert.rejects(newVM(["vm", "--no-repo", "--no-codex-auth"], context), {
    message:
      "vm cannot reach Claude and Fireworks through the gateway; a base built by an older cog lacks this wiring, so run cog base again, or the running gateway is older than this cog, so run ./install.sh",
  });
  assert.deepEqual(calls.slice(-2), [
    ["disable", "lima:vm"],
    ["remove", "vm"],
  ]);
});

test("new asks no one for a Claude token and fails before any VM work when the pool cannot serve", async () => {
  for (const [pool, message] of [
    [
      "unconfigured",
      "the Claude pool has no account; run cog pool add NAME, or pass --no-claude-token",
    ],
    [
      "unusable",
      "the Claude pool is not usable: account work is broken; fix that (cog pool rm NAME removes an account), or pass --no-claude-token",
    ],
    [
      "old",
      "cannot read the Claude pool state from the gateway: the running gateway is older than this cog; run ./install.sh in the cog checkout, or pass --no-claude-token",
    ],
  ] as const) {
    const { calls, context, failures } = fixture();
    failures.pool = pool;
    await assert.rejects(
      newVM(["vm", "--no-repo", "--no-codex-auth"], context),
      {
        message,
      },
    );
    assert.deepEqual(calls, [
      ["health"],
      ["exists", "base"],
      ["exists", "vm"],
      ["sync"],
      ["pool"],
    ]);
  }
});

test("new stops before any VM work when the gateway cannot read the pool again", async () => {
  const { calls, context, failures } = fixture();
  failures.syncFails = true;
  await assert.rejects(newVM(["vm", "--no-repo", "--no-codex-auth"], context), {
    message:
      "cannot read the Claude pool state from the gateway: gateway administration failed, or pass --no-claude-token",
  });
  assert.deepEqual(calls, [
    ["health"],
    ["exists", "base"],
    ["exists", "vm"],
    ["sync"],
  ]);
});

test.each([
  [
    "the wiring step",
    ["sudo", "/usr/local/lib/cog/setup-model-gateway", "claude"],
  ],
  [
    "the Anthropic probe",
    [
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--noproxy",
      "*",
      "--output",
      "/dev/null",
      "https://api.anthropic.com/__cog__/health",
    ],
  ],
] as const)(
  "a failure of %s says to run cog base and rolls back",
  async (_, step) => {
    const { calls, context, failures } = fixture();
    failures.probeFails = step.at(-1) ?? "";
    await assert.rejects(
      newVM(["vm", "--no-repo", "--no-codex-auth"], context),
      {
        message:
          "vm cannot reach Claude through the gateway; a base built by an older cog lacks this wiring, so run cog base again",
      },
    );
    assert.deepEqual(calls.slice(-2), [
      ["disable", "lima:vm"],
      ["remove", "vm"],
    ]);
    assert.equal(
      calls.some(
        ([method, , argv]) =>
          method === "shell" &&
          (argv as string[])[0]?.endsWith("setup-secrets"),
      ),
      false,
    );
  },
);

test("--no-claude-token skips the pool, the wiring and the placeholder", async () => {
  const { calls, context, failures } = fixture();
  failures.pool = "unconfigured";
  await newVM(noSecrets, context);
  const text = JSON.stringify(calls);
  assert.equal(text.includes('"pool"'), false);
  assert.equal(text.includes("setup-model-gateway"), false);
  assert.equal(text.includes("api.anthropic.com"), false);
  assert.equal(text.includes("setup-secrets"), false);
});

const noSecrets = ["vm", "--no-repo", "--no-claude-token", "--no-codex-auth"];

test("new does not delete a VM if the name is taken during clone", async () => {
  const { calls, context } = fixture();
  context.lima.clone = () => Promise.reject(new Error("name already taken"));
  await assert.rejects(newVM(noSecrets, context), /name already taken/);
  assert.deepEqual(calls, [["health"], ["exists", "base"], ["exists", "vm"]]);
});

test.each([
  ["a socket outside the socket directory", "/elsewhere/github-ab-12.sock"],
  ["a socket in a subdirectory", "SOCKETS/sub/github-ab-12.sock"],
  ["a relative socket", "github-ab-12.sock"],
  ["a socket with the wrong name", "SOCKETS/other.sock"],
  ["a socket with an uppercase name", "SOCKETS/github-AB.sock"],
] as const)(
  "new refuses %s before it edits the Lima config",
  async (_, bad) => {
    const { calls, context } = fixture();
    const { location } = context.gateway();
    const socket = bad.replace("SOCKETS", location.sockets);
    const gateway = context.gateway;
    await assert.rejects(
      newVM(noSecrets, {
        ...context,
        gateway: () => ({
          ...gateway(),
          register: (name: string) =>
            Promise.resolve({
              name,
              id: "id",
              socket,
              revision: 0,
              disabled: false,
            }),
        }),
      }),
      { message: "the GitHub gateway returned an invalid socket" },
    );
    assert.ok(calls.every(([method]) => method !== "edit"));
    assert.deepEqual(calls.at(-2), ["disable", "lima:vm"]);
    assert.deepEqual(calls.at(-1), ["remove", "vm"]);
  },
);

test.each([
  ["{{", "/state/{{.Home}}/sock"],
  ["%", "/state/%h/sock"],
  ["$", "/state/${HOME}/sock"],
  [":", "/state/a:b/sock"],
] as const)(
  "new refuses a state directory with %s in it, before cloning",
  async (character, sockets) => {
    const { calls, context } = fixture();
    const gateway = context.gateway;
    await assert.rejects(
      newVM(noSecrets, {
        ...context,
        gateway: () => ({
          ...gateway(),
          location: { ...gateway().location, sockets },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(
            `contains "${character}", which Lima or ssh would read as something else`,
          ),
          error.message,
        );
        return true;
      },
    );
    assert.ok(calls.every(([method]) => method !== "clone"));
  },
);

function registering(
  context: ReturnType<typeof fixture>["context"],
  register: Control["register"],
): ReturnType<typeof fixture>["context"] {
  const gateway = context.gateway;
  return { ...context, gateway: () => ({ ...gateway(), register }) };
}

test("new says why the gateway refuses the registration when the reason is one of its own fixed messages", async () => {
  const { calls, context } = fixture();
  const { state, location } = context.gateway();
  const socket = path.join(location.sockets, "github-ab-12.sock");
  state.register("lima:vm", socket, "test");
  await assert.rejects(
    newVM(
      noSecrets,
      registering(context, (name) =>
        Promise.resolve(state.register(name, socket, "test")),
      ),
    ),
    {
      message:
        "cannot register vm with the GitHub gateway: VM is already registered",
    },
  );
  assert.deepEqual(calls.at(-1), ["remove", "vm"]);
  assert.ok(calls.every(([method]) => method !== "disable"));
});

test("new says that the socket path is too long, which only the registration finds", async () => {
  const { context } = fixture();
  const long = new Control(
    locations({ COG_ROOT: path.join(context.config.home, "x".repeat(100)) }),
    { actor: "test" },
  );
  await assert.rejects(
    newVM(
      noSecrets,
      registering(context, (name) => long.register(name)),
    ),
    {
      message:
        "cannot register vm with the GitHub gateway: the state directory is too long for a Unix socket",
    },
  );
});

test("new names the gateway's log, and shows nothing of the reason, when the registration fails in any other way", async () => {
  const { context } = fixture();
  await assert.rejects(
    newVM(
      noSecrets,
      registering(context, () =>
        Promise.reject(new Error("EACCES: permission denied, mkdir '/place'")),
      ),
    ),
    {
      message:
        "cannot register vm with the GitHub gateway; see ~/Library/Logs/dev.msrl.cog.gateway.err",
    },
  );
});

test("rm deletes a VM whose registration is already disabled, when the VM still forwards to the registered socket", async () => {
  const { context } = fixture();
  const gateway = context.gateway();
  const { state } = gateway;
  const socket = "/old/lima/vm/sock/github-ab-12.sock";
  state.register("lima:vm", socket, "test");
  state.disable("lima:vm", "test");
  state.register("lima:reused", "/old/lima/reused/sock/github-cd-34.sock", "t");
  state.disable("lima:reused", "test");
  const removed: string[] = [];
  const retired = {
    ...context,
    lima: {
      ...context.lima,
      hasGatewaySocket: (name: string, saved: string) =>
        Promise.resolve(name === "vm" && saved === socket),
      remove: (name: string) => {
        removed.push(name);
        return Promise.resolve();
      },
    },
    gateway: () => ({
      ...gateway,
      disable: (name: string, options?: { forRemoval?: boolean }) =>
        Promise.resolve(state.disable(name, "test", options)),
    }),
  };
  await remove(["vm"], retired);
  assert.deepEqual(removed, ["vm"]);
  await assert.rejects(remove(["reused"], retired), /VM is not active/);
  await assert.rejects(remove(["never"], retired), /VM is not active/);
  assert.deepEqual(removed, ["vm"]);
});

test("a shell handoff failure leaves the ready VM and registration intact", async () => {
  const { calls, context } = fixture();
  context.lima.enter = () => Promise.reject(new Error("shell unavailable"));
  await assert.rejects(
    newVM(
      ["vm", "--repo=owner/repo", "--no-claude-token", "--no-codex-auth"],
      context,
    ),
    /shell unavailable/,
  );
  const methods = new Set(calls.map(([method]) => method));
  assert.ok(methods.has("grant"));
  assert.ok(!methods.has("disable") && !methods.has("remove"));
});

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

async function tailnetVM() {
  const { context, socket } = fixture();
  const { config, lima } = context;
  const promptInput = path.join(config.home, "prompt");
  const clientSecret = "tskey-client-test";
  const key = "tskey-auth-test";
  writeFileSync(promptInput, clientSecret);
  await configureTailscale(["config", "client"], { ...config, promptInput });
  assert.equal(statSync(config.tailscaleFile).mode & 0o777, 0o600);
  const gateway = context.gateway();
  const { state } = gateway;
  const remote = {
    hostname: "",
    dnsSuffix: "",
    nodeId: "node-test",
    enrolled: false,
    interrupted: false,
    unavailable: false,
    deleted: [] as string[],
    present: true,
    revoked: false,
  };
  const request = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    assert.ok(typeof input === "string");
    const route = input.replace("https://api.tailscale.com/api/v2/", "");
    assert.equal(init?.redirect, "error");
    if (route === "oauth/token") {
      assert.ok(init.body instanceof URLSearchParams);
      assert.equal(init.body.get("client_secret"), clientSecret);
      return Promise.resolve(Response.json({ access_token: "api-test" }));
    }
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer api-test",
    );
    if (route === "tailnet/-/keys") {
      assert.ok(typeof init.body === "string");
      const body: unknown = JSON.parse(init.body);
      assert.partialDeepStrictEqual(body, {
        capabilities: {
          devices: {
            create: { reusable: false, ephemeral: false, tags: ["tag:cog"] },
          },
        },
        expirySeconds: 600,
      });
      return Promise.resolve(Response.json({ id: "auth-id", key }));
    }
    if (route === "tailnet/-/keys/auth-id" && init.method === "DELETE") {
      remote.revoked = true;
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const device = {
      nodeId: remote.nodeId,
      hostname: remote.hostname,
      name: remote.hostname + remote.dnsSuffix + ".example.ts.net",
      sshEnabled: true,
      authorized: true,
      tags: ["tag:cog"],
    };
    if (route.startsWith("tailnet/-/devices?")) {
      const query = new URLSearchParams(route.split("?", 2)[1]);
      assert.equal(query.get("tags"), "tag:cog");
      assert.equal(query.get("hostname"), remote.hostname);
      return Promise.resolve(
        Response.json({
          devices: remote.enrolled
            ? [device, { ...device, hostname: "different", nodeId: "other" }]
            : [],
        }),
      );
    }
    if (init.method === "DELETE") {
      assert.equal(route, "device/" + remote.nodeId);
      if (remote.unavailable)
        return Promise.resolve(new Response(key, { status: 503 }));
      remote.deleted.push(remote.nodeId);
      remote.enrolled = false;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    assert.equal(route, `device/${remote.nodeId}?fields=all`);
    return Promise.resolve(Response.json(device));
  };
  const api = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(request, { preconnect: fetch.preconnect }),
  );
  onTestFinished(() => {
    api.mockRestore();
  });
  const shell = lima.shell;
  lima.shell = async (name, args, options) => {
    assert.ok(!args.join(" ").includes(clientSecret));
    assert.ok(!args.join(" ").includes(key));
    if (args.includes("tailscale")) {
      remote.hostname =
        args.find((arg) => arg.startsWith("--hostname="))?.slice(11) ?? "";
      if (args.includes("up")) {
        assert.equal(options?.quiet, true);
        assert.deepEqual(options.stdin, new TextEncoder().encode(key));
        assert.ok(args.includes("--auth-key=file:/dev/stdin"));
        assert.ok(
          args.includes("--accept-dns=false") &&
            args.includes("--accept-routes=false") &&
            args.includes("--ssh"),
        );
        remote.enrolled = true;
        if (remote.interrupted) process.emit("SIGTERM", "SIGTERM");
      }
    }
    await shell(name, args, options);
  };
  lima.shellOutput = (_name, args) => {
    assert.deepEqual(args, ["id", "-un"]);
    return Promise.resolve("shields");
  };
  lima.hasGatewaySocket = (_name, savedSocket) =>
    Promise.resolve(remote.present && savedSocket === socket);
  lima.remove = () => {
    remote.present = false;
    return Promise.resolve();
  };
  return {
    context: {
      ...context,
      gateway: () => ({
        ...gateway,
        register: (name: string) =>
          Promise.resolve(state.register(name, socket, "test")),
        disable: (name: string, options?: { forRemoval?: boolean }) =>
          Promise.resolve(state.disable(name, "test", options)),
      }),
    },
    state,
    remote,
  };
}

test("new enrolls with a one-use key and rm retries after deleting the stopped VM", async () => {
  const { context, state, remote } = await tailnetVM();
  assert.equal(await newVM(noSecrets, context), 17);
  const record = state.tailscaleNode("lima:vm");
  assert.ok(record);
  assert.equal(record.nodeId, remote.nodeId);
  assert.equal(remote.hostname, "cog-vm");
  remote.unavailable = true;
  await assert.rejects(remove(["vm"], context), {
    message: "Tailscale API request failed with HTTP 503",
  });
  assert.equal(remote.present, false);
  assert.equal(state.byId(record.instanceId)?.disabled, true);
  assert.throws(
    () => state.register("lima:vm", "/other", "test"),
    /pending Tailscale cleanup/,
  );
  remote.unavailable = false;
  await remove(["vm"], context);
  assert.deepEqual(remote.deleted, ["node-test"]);
  assert.equal(state.tailscaleNode("lima:vm"), null);
  assert.notEqual(
    state.register("lima:vm", "/other", "test").id,
    record.instanceId,
  );
});

test("interrupted enrollment revokes the key and cleans up the device before its ID was saved", async () => {
  const { context, state, remote } = await tailnetVM();
  remote.interrupted = true;
  await assert.rejects(newVM(noSecrets, context), { status: 143 });
  assert.equal(remote.revoked, true);
  assert.deepEqual(remote.deleted, ["node-test"]);
  assert.equal(state.tailscaleNode("lima:vm"), null);
  assert.equal(remote.present, false);
});

test("a malformed Tailscale credential fails before cloning without quoting its contents", async () => {
  const { context, calls } = fixture();
  const file = context.config.tailscaleFile;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "private-broken-credential", { mode: 0o600 });
  await assert.rejects(newVM(noSecrets, context), {
    message:
      "cannot read Tailscale credential; run cog tailscale config CLIENT-ID",
  });
  assert.ok(calls.every(([method]) => method !== "clone"));
});

test("each clone gets its own device and reports the assigned MagicDNS name", async () => {
  const { context, state, remote } = await tailnetVM();
  const credential = tailscaleCredential(context.config.tailscaleFile);
  assert.ok(credential);
  for (const [name, nodeId] of [
    ["A_1", "first"],
    ["A.1", "second"],
  ] as const) {
    const instance = state.register("lima:" + name, "/" + name, "test");
    remote.nodeId = nodeId;
    remote.dnsSuffix = nodeId === "first" ? "" : "-1";
    const address = await enrollTailscale(
      context.lima,
      state,
      credential,
      name,
      instance.id,
    );
    assert.equal(address, `shields@cog-a-1${remote.dnsSuffix}.example.ts.net`);
    assert.equal(state.tailscaleNode(instance.name)?.nodeId, nodeId);
  }
});

test("late enrollment failure cannot revoke or delete a replacement VM", async () => {
  const { context, state, remote } = await tailnetVM();
  const shell = context.lima.shell;
  context.lima.shell = async (name, args, options) => {
    if (args.includes("set")) {
      await remove([name], context);
      state.register("lima:" + name, "/different/socket", "test");
      remote.present = true;
      throw new Error("original VM disappeared");
    }
    await shell(name, args, options);
  };
  await assert.rejects(newVM(noSecrets, context), /original VM disappeared/);
  assert.equal(remote.present, true);
  assert.equal(state.byName("lima:vm")?.socket, "/different/socket");
});
