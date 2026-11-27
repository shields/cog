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
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import type { PoolStatus } from "../gateway/control.ts";
import { compareCodeUnits } from "../gateway/policy.ts";
import { loadPool, unconfiguredReason } from "../gateway/pool.ts";
import { poolCommand, type PoolContext, type PoolIo } from "./commands/pool.ts";
import { loadConfig } from "./config.ts";
import { CogError, Interrupted } from "./errors.ts";

const alpha = "sk-ant-oat01-made-up-alpha-part";
const bravo = "sk-ant-oat01-made-up-bravo-part";
const typed = "sk-ant-oat01-zq7x-made-up-typed-part";
const noon = Date.UTC(2026, 10, 24, 12, 0, 0);

function scratch(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cog-pool-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

interface Captured extends PoolIo {
  out: string[];
  linked: { names: string[]; usable: boolean }[];
  linkFails: boolean;
  closeFails: boolean;
  onLink?: () => void;
  afterLink?: (temporary: string) => void;
}

function capture(pool = ""): Captured {
  const captured: Captured = {
    out: [],
    linked: [],
    linkFails: false,
    closeFails: false,
    say: (text) => {
      captured.out.push(`${text}\n`);
    },
    link: (existing, created) => {
      captured.onLink?.();
      if (pool !== "") {
        captured.linked.push({
          names: readdirSync(pool).toSorted(compareCodeUnits),
          usable: loadPool(pool).usable,
        });
      }
      if (captured.linkFails) {
        throw Object.assign(new Error(`disk ${typed}`), { code: "ENOSPC" });
      }
      linkSync(existing, created);
      captured.afterLink?.(existing);
    },
    close: (descriptor) => {
      closeSync(descriptor);
      if (captured.closeFails) {
        throw Object.assign(new Error(`disk ${typed}`), { code: "EIO" });
      }
    },
  };
  return captured;
}

interface Options {
  token?: string;
  syncFails?: boolean;
  statusFails?: boolean;
  status?: PoolStatus;
}

function fixture(options: Options = {}) {
  const root = scratch();
  const pool = path.join(root, "secrets", "claude-pool");
  const calls: string[] = [];
  let prompts = 0;
  const context: PoolContext & { onPrompt?: () => void } = {
    config: loadConfig({ HOME: root }),
    prompt: () => {
      prompts++;
      context.onPrompt?.();
      return Promise.resolve(options.token ?? typed);
    },
    gateway: () => ({
      location: {
        state: path.join(root, "state"),
        sockets: path.join(root, "state", "sock"),
        secrets: path.join(root, "secrets"),
        admin: path.join(root, "state", "admin.sock"),
        pool,
      },
      sync: () => {
        calls.push("sync");
        return options.syncFails
          ? Promise.reject(new Error("gateway administration failed"))
          : Promise.resolve();
      },
      pool: () => {
        calls.push("pool");
        if (options.statusFails) {
          return Promise.reject(new Error("gateway administration failed"));
        }
        if (options.status) {
          return Promise.resolve(options.status);
        }
        const loaded = loadPool(pool);
        return Promise.resolve<PoolStatus>(
          loaded.usable
            ? {
                state: "usable",
                reason: null,
                accounts: loaded.accounts.map(({ name }) => ({
                  name,
                  held: false,
                  heldUntil: null,
                  buckets: [],
                })),
              }
            : loaded.reason === unconfiguredReason
              ? { state: "unconfigured", reason: null, accounts: [] }
              : { state: "unusable", reason: loaded.reason, accounts: [] },
        );
      },
    }),
  };
  return {
    root,
    pool,
    calls,
    context,
    io: capture(pool),
    prompts: () => prompts,
  };
}

function seed(pool: string, accounts: Record<string, string>): void {
  mkdirSync(pool, { recursive: true, mode: 0o700 });
  chmodSync(pool, 0o700);
  for (const [name, token] of Object.entries(accounts)) {
    writeFileSync(path.join(pool, name), `${token}\n`, { mode: 0o600 });
  }
}

async function withUmask(
  mask: number,
  work: () => Promise<void>,
): Promise<void> {
  const previous = process.umask(mask);
  try {
    await work();
  } finally {
    process.umask(previous);
  }
}

async function failure(work: Promise<void>): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof CogError, String(error));
    return error.message;
  }
  throw new Error("the command succeeded");
}

function noToken(...shown: string[]): void {
  const text = shown.join("\n");
  for (const part of [alpha, bravo, typed, "made-up", "sk-ant"]) {
    assert.ok(!text.includes(part), "a token is shown");
  }
}

test.each(
  [0o000, 0o022, 0o077].map(
    (mask) => [mask.toString(8).padStart(3, "0"), mask] as const,
  ),
)(
  "add creates the directory with mode 700 and the file with mode 600 under umask %s, then reloads",
  async (_label, mask) => {
    const { pool, calls, context, io } = fixture();
    const { out } = io;
    await withUmask(mask, () => poolCommand(["add", "work"], context, io));
    assert.equal(statSync(pool).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(pool, "work")).mode & 0o777, 0o600);
    assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${typed}\n`);
    assert.deepEqual(readdirSync(pool), ["work"]);
    assert.deepEqual(calls, ["sync", "pool"]);
    assert.equal(out.length, 1);
    assert.match(out[0] ?? "", /work is saved/);
    assert.match(out[0] ?? "", /1 account/);
    noToken(...out);
  },
);

test("add keeps the other accounts and the mode of an acceptable directory", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  await poolCommand(["add", "bravo"], context, io);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "bravo",
  ]);
  assert.equal(readFileSync(path.join(pool, "alpha"), "utf8"), `${alpha}\n`);
});

test.each(["", "Work", "-a", ".hidden", "a/b", "a b", "a".repeat(33), "a_b"])(
  "add refuses the name %j before it prompts or creates anything",
  async (name) => {
    const { root, context, prompts, io } = fixture();
    const message = await failure(poolCommand(["add", name], context, io));
    assert.match(message, /account name/);
    assert.equal(prompts(), 0);
    assert.equal(existsSync(path.join(root, "secrets")), false);
  },
);

test.each([
  [[], /^usage: cog pool add NAME \| rm NAME \| list \| status$/],
  [["add"], /^usage: cog pool/],
  [["add", "a", "b"], /^usage: cog pool/],
  [["rm"], /^usage: cog pool/],
  [["rm", "a", "b"], /^usage: cog pool/],
  [["list", "a"], /^usage: cog pool/],
  [["status", "a"], /^usage: cog pool/],
  [["other"], /^usage: cog pool/],
] as const)("%j is a usage error", async (args, message) => {
  const { context, io } = fixture();
  assert.match(await failure(poolCommand([...args], context, io)), message);
});

test.each([
  ["wrong-prefix-made-up-part", /starts with sk-ant-oat/],
  [`sk-ant-oat01-${"x".repeat(4100)}`, /at most 4096/],
  ["sk-ant-oat01-café-made-up", /visible ASCII/],
])(
  "add refuses a token that the loader would refuse and shows no part of it",
  async (token, rule) => {
    const { pool, context, calls, io } = fixture({ token });
    const message = await failure(poolCommand(["add", "work"], context, io));
    assert.match(message, rule);
    assert.ok(!message.includes(token.slice(5, 20)));
    assert.equal(existsSync(pool), false);
    assert.deepEqual(calls, []);
  },
);

test("add refuses an existing entry of any kind and changes nothing", async () => {
  const { pool, context, prompts, calls, io } = fixture();
  seed(pool, { alpha });
  const elsewhere = path.join(pool, "..", "elsewhere");
  writeFileSync(elsewhere, `${bravo}\n`);
  symlinkSync(elsewhere, path.join(pool, "link"));
  mkdirSync(path.join(pool, "folder"));
  assert.match(
    await failure(poolCommand(["add", "alpha"], context, io)),
    /run cog pool rm alpha first/,
  );
  for (const name of ["link", "folder"]) {
    const message = await failure(poolCommand(["add", name], context, io));
    assert.match(message, new RegExp(`account ${name} is not a regular file`));
    assert.ok(message.includes(`remove ${path.join(pool, name)} by hand`));
    assert.ok(!message.includes("cog pool rm"));
  }
  assert.equal(prompts(), 0);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(path.join(pool, "alpha"), "utf8"), `${alpha}\n`);
  assert.equal(readFileSync(elsewhere, "utf8"), `${bravo}\n`);
  assert.equal(lstatSync(path.join(pool, "link")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "folder",
    "link",
  ]);
});

test("add refuses an entry that appears while the token is being typed, and overwrites nothing", async () => {
  const { pool, context, calls, io } = fixture();
  seed(pool, { alpha });
  context.onPrompt = () => {
    writeFileSync(path.join(pool, "work"), `${bravo}\n`, { mode: 0o600 });
  };
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(message, /run cog pool rm work first/);
  assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${bravo}\n`);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "work",
  ]);
  assert.deepEqual(calls, []);
});

test.each(
  [0o755, 0o770, 0o707].map((mode) => [mode.toString(8), mode] as const),
)(
  "add refuses a directory of mode %s and changes nothing",
  async (_label, mode) => {
    const { pool, context, prompts, io } = fixture();
    seed(pool, { alpha });
    chmodSync(pool, mode);
    const message = await failure(poolCommand(["add", "work"], context, io));
    assert.match(message, /accessible to group or other/);
    assert.match(message, /nothing was changed/);
    assert.equal(prompts(), 0);
    assert.equal(statSync(pool).mode & 0o777, mode);
    assert.deepEqual(readdirSync(pool), ["alpha"]);
  },
);

test("add refuses a location that is a link or a file and changes nothing", async () => {
  const { root, pool, context, io } = fixture();
  mkdirSync(path.join(root, "secrets"));
  const real = path.join(root, "real");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, pool);
  const linked = await failure(poolCommand(["add", "work"], context, io));
  assert.match(linked, /not a real directory/);
  assert.deepEqual(readdirSync(real), []);
  rmSync(pool);
  writeFileSync(pool, "");
  assert.match(
    await failure(poolCommand(["add", "work"], context, io)),
    /not a real directory/,
  );
});

test("add names its temporary file so that the loader skips it, and links rather than renames", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  await poolCommand(["add", "work"], context, io);
  assert.equal(io.linked.length, 1);
  const [first] = io.linked;
  assert.ok(first);
  assert.equal(first.usable, true);
  const staged = first.names.filter((name) => name !== "alpha");
  assert.equal(staged.length, 1);
  assert.match(staged[0] ?? "", /^\.work\.[0-9a-f]{12}$/);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "work",
  ]);
});

const held = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

function listeners(): number[] {
  return held.map((name) => process.listenerCount(name));
}

async function interrupted(work: Promise<void>): Promise<number> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof Interrupted, String(error));
    return error.status;
  }
  throw new Error("the command succeeded");
}

for (const [signal, status] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`add finishes the write when ${signal} arrives in the middle, then ends as interrupted`, async () => {
    const { pool, context, io, calls } = fixture();
    seed(pool, { alpha });
    const before = listeners();
    const index = held.indexOf(signal);
    io.onLink = () => {
      assert.ok(process.listenerCount(signal) > (before[index] ?? 0));
      process.emit(signal, signal);
    };
    assert.equal(
      await interrupted(poolCommand(["add", "work"], context, io)),
      status,
    );
    assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
      "alpha",
      "work",
    ]);
    assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${typed}\n`);
    assert.equal(statSync(path.join(pool, "work")).mode & 0o777, 0o600);
    assert.deepEqual(calls, []);
    assert.deepEqual(listeners(), before);
  });
}

test("add ends as interrupted when a real SIGINT arrives during the write", async () => {
  const { pool, context, io, calls } = fixture();
  seed(pool, { alpha });
  const before = listeners();
  io.onLink = () => {
    process.kill(process.pid, "SIGINT");
    const end = Date.now() + 100;
    while (Date.now() < end) {
      // The signal is delivered while the write holds the event loop.
    }
  };
  assert.equal(
    await interrupted(poolCommand(["add", "work"], context, io)),
    130,
  );
  assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${typed}\n`);
  assert.deepEqual(calls, []);
  assert.deepEqual(listeners(), before);
});

test("add removes its signal handlers after a success and after a failure", async () => {
  const before = listeners();
  const ok = fixture();
  seed(ok.pool, { alpha });
  await poolCommand(["add", "work"], ok.context, ok.io);
  assert.deepEqual(listeners(), before);
  const bad = fixture();
  seed(bad.pool, { alpha });
  bad.io.linkFails = true;
  await failure(poolCommand(["add", "work"], bad.context, bad.io));
  assert.deepEqual(listeners(), before);
});

test("add that finds its temporary file gone after the link still saves the account and reloads the gateway", async () => {
  const { pool, calls, context, io } = fixture();
  seed(pool, { alpha });
  io.afterLink = (temporary) => {
    unlinkSync(temporary);
  };
  await poolCommand(["add", "work"], context, io);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "work",
  ]);
  assert.deepEqual(calls, ["sync", "pool"]);
});

test("add that cannot remove its temporary file after the link says that the token is saved, and names the file", async () => {
  const { pool, calls, context, io } = fixture();
  seed(pool, { alpha });
  io.afterLink = (temporary) => {
    unlinkSync(temporary);
    mkdirSync(temporary);
  };
  const before = listeners();
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(
    message,
    /^the token for work is saved in .+, but its temporary file .+\.work\.[0-9a-f]{12} cannot be removed \((?:EPERM|EISDIR)\); remove it by hand$/,
  );
  noToken(message);
  assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${typed}\n`);
  assert.equal(statSync(path.join(pool, "work")).mode & 0o777, 0o600);
  assert.deepEqual(calls, []);
  assert.deepEqual(listeners(), before);
});

test("add that fails and is interrupted ends as interrupted and leaves no temporary", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  io.linkFails = true;
  io.onLink = () => {
    process.emit("SIGINT", "SIGINT");
  };
  const before = listeners();
  assert.equal(
    await interrupted(poolCommand(["add", "work"], context, io)),
    130,
  );
  assert.deepEqual(readdirSync(pool), ["alpha"]);
  assert.deepEqual(listeners(), before);
});

for (const verb of ["add", "rm"] as const) {
  test(`${verb} removes an old stray temporary and leaves younger and unrelated files`, async () => {
    const { pool, context, io } = fixture();
    seed(pool, { alpha });
    const old = ".gone.0123456789ab";
    const young = ".fresh.0123456789ab";
    const dot = ".other";
    const odd = ".gone.0123456789abc";
    const inside = ".x.gone.0123456789ab";
    const folder = ".dir.0123456789ab";
    for (const name of [old, young, dot, odd, inside]) {
      writeFileSync(path.join(pool, name), `${bravo}\n`, { mode: 0o600 });
    }
    mkdirSync(path.join(pool, folder));
    const aged = (Date.now() - 90_000) / 1000;
    for (const name of [old, dot, odd, inside, folder]) {
      utimesSync(path.join(pool, name), aged, aged);
    }
    const recent = (Date.now() - 30_000) / 1000;
    utimesSync(path.join(pool, young), recent, recent);
    await poolCommand(
      verb === "add" ? ["add", "work"] : ["rm", "alpha"],
      context,
      io,
    );
    assert.equal(existsSync(path.join(pool, old)), false);
    for (const name of [young, dot, odd, inside, folder]) {
      assert.equal(existsSync(path.join(pool, name)), true, name);
    }
  });
}

for (const [step, errno] of [
  ["link", "ENOSPC"],
  ["close", "EIO"],
] as const) {
  for (const created of [false, true]) {
    test(`add leaves no stray file after the ${step} fails${created ? ", and removes the directory it made" : ""}`, async () => {
      const { root, pool, context, calls, io } = fixture();
      if (!created) {
        seed(pool, { alpha });
      }
      if (step === "link") {
        io.linkFails = true;
      } else {
        io.closeFails = true;
      }
      const message = await failure(poolCommand(["add", "work"], context, io));
      assert.match(
        message,
        new RegExp(String.raw`cannot write account work \(${errno}\)`),
      );
      noToken(message);
      assert.deepEqual(calls, []);
      assert.equal(io.linked.length, step === "link" ? 1 : 0);
      if (created) {
        assert.equal(existsSync(pool), false);
        assert.deepEqual(readdirSync(path.join(root, "secrets")), []);
      } else {
        assert.deepEqual(readdirSync(pool), ["alpha"]);
      }
    });
  }
}

for (const [step, errno] of [
  ["link", "ENOSPC"],
  ["close", "EIO"],
] as const) {
  test(`add leaves an existing empty pool directory in place after the ${step} fails`, async () => {
    const { pool, context, io } = fixture();
    mkdirSync(pool, { recursive: true, mode: 0o700 });
    chmodSync(pool, 0o700);
    if (step === "link") {
      io.linkFails = true;
    } else {
      io.closeFails = true;
    }
    const message = await failure(poolCommand(["add", "work"], context, io));
    assert.match(
      message,
      new RegExp(String.raw`cannot write account work \(${errno}\)`),
    );
    assert.equal(statSync(pool).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(pool), []);
  });
}

test("add says that the token is saved when the gateway cannot be told, and exits with an error", async () => {
  const { pool, context, io } = fixture({ syncFails: true });
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(message, /^the token for work is saved in /);
  assert.match(message, /could not reload it: gateway administration failed/);
  assert.equal(readFileSync(path.join(pool, "work"), "utf8"), `${typed}\n`);
  noToken(message);
});

test("add says that the token is saved when the pool state cannot be read", async () => {
  const { pool, context, calls, io } = fixture({ statusFails: true });
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(message, /is saved in .*could not reload it/);
  assert.deepEqual(calls, ["sync", "pool"]);
  assert.equal(existsSync(path.join(pool, "work")), true);
});

test("add fails when the pool is not usable afterwards and gives the reason", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  writeFileSync(path.join(pool, "loose"), `${bravo}\n`, { mode: 0o644 });
  chmodSync(path.join(pool, "loose"), 0o644);
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(message, /^the token for work is saved in /);
  assert.match(message, /not usable: account loose is accessible to group/);
  noToken(message);
});

test("add fails when the gateway reports an unconfigured pool afterwards", async () => {
  const { context, io } = fixture({
    status: { state: "unconfigured", reason: null, accounts: [] },
  });
  const message = await failure(poolCommand(["add", "work"], context, io));
  assert.match(message, /not usable: the Claude pool is not configured/);
});

test("rm removes a regular file and reloads", async () => {
  const { pool, context, calls, io } = fixture();
  seed(pool, { alpha, bravo });
  const { out } = io;
  await poolCommand(["rm", "alpha"], context, io);
  assert.deepEqual(readdirSync(pool), ["bravo"]);
  assert.deepEqual(calls, ["sync", "pool"]);
  assert.match(out[0] ?? "", /account alpha is removed/);
  assert.match(out[0] ?? "", /1 account/);
});

test("rm of the last account succeeds when the gateway then has no account", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  await poolCommand(["rm", "alpha"], context, io);
  assert.deepEqual(readdirSync(pool), []);
});

test("rm fails when the pool is unusable for another reason, after the removal", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  writeFileSync(path.join(pool, "loose"), `${bravo}\n`, { mode: 0o644 });
  chmodSync(path.join(pool, "loose"), 0o644);
  const message = await failure(poolCommand(["rm", "alpha"], context, io));
  assert.match(message, /^account alpha is removed from /);
  assert.match(message, /not usable: account loose is accessible/);
  assert.equal(existsSync(path.join(pool, "alpha")), false);
});

test("rm says what happened when the gateway cannot be told", async () => {
  const { pool, context, io } = fixture({ syncFails: true });
  seed(pool, { alpha, bravo });
  const message = await failure(poolCommand(["rm", "alpha"], context, io));
  assert.match(message, /account alpha is removed from .*could not reload it/);
  assert.equal(existsSync(path.join(pool, "alpha")), false);
});

test("rm refuses a missing entry, a bad name, and an entry that is not a regular file", async () => {
  const { pool, context, calls, io } = fixture();
  seed(pool, { alpha });
  assert.match(
    await failure(poolCommand(["rm", "missing"], context, io)),
    /there is no account missing/,
  );
  assert.match(
    await failure(poolCommand(["rm", "../alpha"], context, io)),
    /account name/,
  );
  const target = path.join(pool, "..", "target");
  writeFileSync(target, `${bravo}\n`);
  symlinkSync(target, path.join(pool, "link"));
  mkdirSync(path.join(pool, "folder"));
  for (const name of ["link", "folder"]) {
    assert.match(
      await failure(poolCommand(["rm", name], context, io)),
      /is not a regular file/,
    );
  }
  assert.equal(readFileSync(target, "utf8"), `${bravo}\n`);
  assert.deepEqual(readdirSync(pool).toSorted(compareCodeUnits), [
    "alpha",
    "folder",
    "link",
  ]);
  assert.deepEqual(calls, []);
});

test("rm removes a stray entry that the loader refuses, by its file name", async () => {
  const { pool, calls, context, io } = fixture();
  seed(pool, { alpha });
  writeFileSync(path.join(pool, "notes.txt"), `${bravo}\n`, { mode: 0o600 });
  writeFileSync(path.join(pool, ".work.0123456789ab"), `${bravo}\n`, {
    mode: 0o600,
  });
  assert.equal(loadPool(pool).usable, false);
  await poolCommand(["rm", "notes.txt"], context, io);
  assert.equal(loadPool(pool).usable, true);
  await poolCommand(["rm", ".work.0123456789ab"], context, io);
  assert.deepEqual(readdirSync(pool), ["alpha"]);
  assert.deepEqual(calls, ["sync", "pool", "sync", "pool"]);
  noToken(...io.out);
});

test("rm removes an old stray temporary that it is asked for by name, as an account", async () => {
  const { pool, calls, context, io } = fixture();
  seed(pool, { alpha });
  const stray = path.join(pool, ".gone.0123456789ab");
  writeFileSync(stray, `${bravo}\n`, { mode: 0o600 });
  const aged = (Date.now() - 120_000) / 1000;
  utimesSync(stray, aged, aged);
  await poolCommand(["rm", ".gone.0123456789ab"], context, io);
  assert.deepEqual(readdirSync(pool), ["alpha"]);
  assert.deepEqual(calls, ["sync", "pool"]);
  noToken(...io.out);
});

test("rm refuses a location that is a link and touches nothing in its target", async () => {
  const { root, pool, calls, context, io } = fixture();
  mkdirSync(path.join(root, "secrets"));
  const real = path.join(root, "real");
  seed(real, { work: alpha });
  const stray = path.join(real, ".work.0123456789ab");
  writeFileSync(stray, `${bravo}\n`, { mode: 0o600 });
  const aged = (Date.now() - 120_000) / 1000;
  utimesSync(stray, aged, aged);
  symlinkSync(real, pool);
  const message = await failure(poolCommand(["rm", "work"], context, io));
  assert.match(message, /not a real directory/);
  assert.match(message, /nothing was changed/);
  assert.deepEqual(readdirSync(real).toSorted(compareCodeUnits), [
    ".work.0123456789ab",
    "work",
  ]);
  assert.deepEqual(calls, []);
});

test.each(["", ".", "..", "a/b", "../alpha", "/alpha"])(
  "rm refuses the name %j without touching the pool directory",
  async (name) => {
    const { pool, calls, context, io } = fixture();
    seed(pool, { alpha });
    assert.match(
      await failure(poolCommand(["rm", name], context, io)),
      /account name/,
    );
    assert.deepEqual(readdirSync(pool), ["alpha"]);
    assert.deepEqual(calls, []);
  },
);

test("rm with no pool directory says there is no account", async () => {
  const { context, io } = fixture();
  assert.match(
    await failure(poolCommand(["rm", "alpha"], context, io)),
    /there is no account alpha/,
  );
});

test("list prints the names in the loader's order without the gateway", async () => {
  const { pool, context, calls, io } = fixture();
  seed(pool, { b: alpha, "a-1": bravo, a: alpha, "0": bravo });
  writeFileSync(path.join(pool, ".hidden"), "ignored");
  const { out } = io;
  await poolCommand(["list"], context, io);
  assert.deepEqual(out, ["0\n", "a\n", "a-1\n", "b\n"]);
  assert.deepEqual(calls, []);
});

test("list prints nothing for a missing or empty directory", async () => {
  const { pool, context, io } = fixture();
  const { out } = io;
  await poolCommand(["list"], context, io);
  mkdirSync(pool, { recursive: true, mode: 0o700 });
  await poolCommand(["list"], context, io);
  assert.deepEqual(out, []);
  assert.deepEqual(loadPool(pool), {
    usable: false,
    reason: unconfiguredReason,
  });
});

test("list fails with the loader's reason, and never shows a token", async () => {
  const { pool, context, io } = fixture();
  seed(pool, { alpha });
  writeFileSync(path.join(pool, "bad"), "not-a-token-at-all\n", {
    mode: 0o600,
  });
  const { out } = io;
  const bad = await failure(poolCommand(["list"], context, io));
  assert.equal(
    bad,
    "account bad must hold a token that starts with sk-ant-oat",
  );
  chmodSync(pool, 0o755);
  assert.equal(
    await failure(poolCommand(["list"], context, io)),
    "the Claude pool directory is accessible to group or other",
  );
  assert.deepEqual(out, []);
});

test("status prints one line for each account with times in UTC", async () => {
  const { context, io } = fixture({
    status: {
      state: "usable",
      reason: null,
      accounts: [
        {
          name: "alpha",
          held: true,
          heldUntil: noon,
          buckets: [
            { bucket: "5h", utilization: 0.424, expires: noon + 3_600_000 },
            { bucket: "7d", utilization: 1, expires: noon + 86_400_000 },
          ],
        },
        { name: "bravo", held: false, heldUntil: null, buckets: [] },
      ],
    },
  });
  const { out } = io;
  await poolCommand(["status"], context, io);
  assert.deepEqual(out, [
    "alpha; held until 2026-11-24T12:00:00Z; 5h 42% until 2026-11-24T13:00:00Z; 7d 100% until 2026-11-25T12:00:00Z\n",
    "bravo; not held; no rate-limit reading\n",
  ]);
});

test("status of a pool that is not configured says how to add an account and succeeds", async () => {
  const { context, calls, io } = fixture();
  const { out } = io;
  await poolCommand(["status"], context, io);
  assert.deepEqual(out, [
    "the Claude pool is not configured; add an account with: cog pool add NAME\n",
  ]);
  assert.deepEqual(calls, ["pool"]);
});

test("status of a pool that is unusable fails with the reason", async () => {
  const { context, io } = fixture({
    status: {
      state: "unusable",
      reason: "account bad is accessible to group or other",
      accounts: [],
    },
  });
  const { out } = io;
  assert.equal(
    await failure(poolCommand(["status"], context, io)),
    "the Claude pool is not usable: account bad is accessible to group or other",
  );
  assert.deepEqual(out, []);
});

test("status fails when the gateway cannot be asked", async () => {
  const { context, io } = fixture({ statusFails: true });
  assert.match(
    await failure(poolCommand(["status"], context, io)),
    /cannot read the pool state from the gateway: gateway administration failed/,
  );
});
