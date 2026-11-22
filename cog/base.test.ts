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
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { baseVM } from "./commands/base.ts";
import { guestLib, guestRepo, loadConfig } from "./config.ts";
import { Interrupted } from "./errors.ts";
import { capture, run, signals } from "./proc.ts";
import { writeResources } from "./resources.ts";

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cog-base-test-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const config = loadConfig({ HOME: root, COG_BASE: "base", COG_MEMORY: "8" });
  mkdirSync(config.defaultDotfiles, { recursive: true });
  const source = realpathSync(config.defaultDotfiles);
  const write = (name: string, value: string, mode = 0o644): void => {
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, value, { mode });
    chmodSync(filename, mode);
  };
  write(".zshrc", "/etc/cog-throwaway\n/etc/cog-github-gateway\n");
  write(".zshenv", "/etc/cog-github-gateway\n");
  write(".zsh.d/wt.zsh", "/etc/cog-github-gateway\n");
  write(".codex/hooks/git_guard.py", "/etc/cog-github-gateway\n");
  write(".claude/settings.json", "{}\n");
  write("tools/configure_codex.py", "/etc/cog-throwaway\n");
  write("provision.sh", "#!/bin/sh\n# /etc/cog-github-gateway\n", 0o755);
  await run([
    "git",
    "-C",
    source,
    "init",
    "--quiet",
    "--template=",
    "-b",
    "main",
  ]);
  await run(["git", "-C", source, "add", "."]);
  await run([
    "git",
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    "Initial state",
  ]);
  const head = await capture(["git", "-C", source, "rev-parse", "HEAD"]);

  const calls: unknown[][] = [];
  const mark = (method: string, ...args: unknown[]): Promise<void> => {
    calls.push([method, ...args]);
    return Promise.resolve();
  };
  const status = { exists: true, mounts: "0", interrupt: false };
  let staged: string | undefined;
  const materialize: typeof writeResources = (directory) => {
    staged = directory;
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    return writeResources(directory);
  };
  const context: Parameters<typeof baseVM>[1] = {
    config,
    prompt: () => assert.fail("base does not prompt"),
    gateway: () => assert.fail("base does not use the gateway"),
    lima: {
      exists: async (name) => {
        await mark("exists", name);
        return status.exists;
      },
      isProtected: async (name) => {
        await mark("isProtected", name);
        return true;
      },
      unprotect: (name) => mark("unprotect", name),
      remove: (name) => mark("remove", name),
      create: async (name, size, template) => {
        assert.equal(path.dirname(template), staged);
        assert.equal(statSync(template).mode & 0o777, 0o644);
        await mark("create", name, size);
        if (!status.interrupt) {
          return;
        }
        process.emit("SIGTERM", "SIGTERM");
        signals.check();
      },
      mountCount: async (name) => {
        await mark("mountCount", name);
        return status.mounts;
      },
      guestHome: async (name) => {
        await mark("guestHome", name);
        return "/home/vm";
      },
      pipeInto: async (producer, name, argv, options) => {
        const directory = producer[4];
        assert.ok(directory);
        assert.deepEqual(producer.slice(1), [
          "--no-xattrs",
          "--no-acls",
          "-C",
          directory,
          "-cf",
          "-",
          ".",
        ]);
        assert.deepEqual(options?.producer?.env, { COPYFILE_DISABLE: "1" });
        if (path.basename(directory) === "tree") {
          assert.equal(
            statSync(path.join(directory, ".claude")).mode & 0o777,
            0o755,
          );
          assert.equal(
            statSync(path.join(directory, ".zshrc")).mode & 0o777,
            0o644,
          );
          assert.equal(
            statSync(path.join(directory, "provision.sh")).mode & 0o777,
            0o755,
          );
          assert.equal(
            await capture(["git", "-C", directory, "rev-parse", "HEAD"]),
            head,
          );
          assert.equal(
            await capture(["git", "-C", directory, "ls-files", "local"]),
            "local",
          );
          const branch = await capture([
            "git",
            "-C",
            directory,
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ]);
          assert.equal(branch, "HEAD");
          assert.equal(
            await capture([
              "git",
              "-C",
              directory,
              "remote",
              "get-url",
              "origin",
            ]),
            "https://github.com/example/demo",
          );
        } else {
          assert.equal(
            statSync(path.join(directory, "setup-secrets")).mode & 0o777,
            0o755,
          );
        }
        await mark("pipe", name, path.basename(directory), argv);
      },
      shell: (name, argv, options) =>
        mark("shell", name, argv, options?.workdir),
      stop: (name) => mark("stop", name),
      setShell: (name, shell) => mark("setShell", name, shell),
      protect: (name) => mark("protect", name),
    },
  };
  return {
    calls,
    context,
    materialize,
    source,
    head,
    write,
    status,
    stage: () => staged,
  };
}

test.each([0o000, 0o022, 0o077])(
  "base stages the detached checkout and provisions in order under umask %o",
  async (mask) => {
    const { calls, context, materialize, source, head, write, stage } =
      await fixture();
    await run(["git", "-C", source, "checkout", "--quiet", "--detach", head]);
    await run([
      "git",
      "-C",
      source,
      "remote",
      "add",
      "origin",
      "git@github.com:example/demo",
    ]);
    write("local", "not committed\n", 0o600);
    const previous = process.umask(mask);
    try {
      await baseVM(["dev", "extra"], context, materialize);
    } finally {
      process.umask(previous);
    }
    const directory = stage();
    assert.ok(directory);
    assert.equal(existsSync(directory), false);
    const guest = `/home/vm/${guestRepo}`;
    assert.deepEqual(calls, [
      ["exists", "base"],
      ["isProtected", "base"],
      ["unprotect", "base"],
      ["remove", "base"],
      ["create", "base", ["--memory", "8"]],
      ["mountCount", "base"],
      ["guestHome", "base"],
      [
        "pipe",
        "base",
        "tree",
        [
          "sh",
          "-c",
          'set -eu; rm -rf "$1"; mkdir -p "$1"; tar -xf - --no-same-owner -C "$1"',
          "_",
          guest,
        ],
      ],
      [
        "shell",
        "base",
        [
          "sudo",
          "install",
          "-d",
          "-m",
          "755",
          "-o",
          "root",
          "-g",
          "root",
          guestLib,
        ],
        undefined,
      ],
      [
        "pipe",
        "base",
        "guest",
        [
          "sudo",
          "tar",
          "-x",
          "--no-same-owner",
          "--no-same-permissions",
          "-C",
          guestLib,
        ],
      ],
      [
        "shell",
        "base",
        ["sudo", "chown", "-R", "root:root", guestLib],
        undefined,
      ],
      [
        "shell",
        "base",
        ["sudo", "chmod", "-R", "u=rwX,go=rX", guestLib],
        undefined,
      ],
      ["shell", "base", ["./provision.sh", "dev", "extra"], guest],
      ["shell", "base", ["git", "reset", "--mixed", "--quiet", "HEAD"], guest],
      [
        "shell",
        "base",
        [
          "sudo",
          `${guestLib}/throwaway.sh`,
          "--claude-settings",
          `${guest}/.claude/settings.json`,
        ],
        undefined,
      ],
      [
        "shell",
        "base",
        [
          "env",
          "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
          "uv",
          "run",
          "--no-dev",
          "python",
          "tools/configure_codex.py",
          "/home/vm/.codex/config.toml",
        ],
        guest,
      ],
      [
        "shell",
        "base",
        ["sudo", "systemctl", "mask", "--now", "tailscaled.service"],
        undefined,
      ],
      [
        "shell",
        "base",
        ["sudo", "test", "!", "-e", "/var/lib/tailscale/tailscaled.state"],
        undefined,
      ],
      [
        "shell",
        "base",
        ["sudo", "truncate", "-s", "0", "/etc/machine-id"],
        undefined,
      ],
      ["shell", "base", [`${guestLib}/reset-identity.sh`], undefined],
      ["stop", "base"],
      ["setShell", "base", "/usr/bin/zsh"],
      ["protect", "base"],
    ]);
  },
);

test("base fails before Lima if an embedded guest file contains a secret", async () => {
  const { calls, context, materialize, stage } = await fixture();
  await assert.rejects(
    baseVM([], context, (directory) => {
      const resources = materialize(directory);
      const marker = "AbCdEf0123456789AzByCx9876543210MwVt";
      appendFileSync(
        path.join(resources.guest, "setup-secrets"),
        `\n# ghp_${marker}\n`,
      );
      return resources;
    }),
    { message: "gitleaks found secrets in guest/, or failed" },
  );
  assert.deepEqual(calls, []);
  const directory = stage();
  assert.ok(directory);
  assert.equal(existsSync(directory), false);
});

test("base rejects both a stale staged reader and an origin with a trailing control", async () => {
  const { calls, context, materialize, source, write } = await fixture();
  write(".zshenv", "no marker\n");
  await assert.rejects(
    baseVM([], context, materialize),
    /\.zshenv in the dotfiles checkout does not name/,
  );
  await run([
    "git",
    "-C",
    source,
    "config",
    "remote.origin.url",
    "https://github.com/example/demo\n",
  ]);
  await assert.rejects(baseVM([], context, materialize), {
    message:
      "origin must not contain query parameters, fragments or control characters",
  });
  assert.deepEqual(calls, []);
});

test.each([false, true])(
  "base removes the stage after start when interrupted=%s",
  async (interrupt) => {
    const { calls, context, materialize, stage, status } = await fixture();
    status.exists = false;
    status.mounts = "3";
    status.interrupt = interrupt;
    await assert.rejects(baseVM([], context, materialize), (error: unknown) =>
      interrupt
        ? error instanceof Interrupted && error.status === 143
        : error instanceof Error &&
          error.message.includes("mounts 3 host directories"),
    );
    assert.deepEqual(calls, [
      ["exists", "base"],
      ["create", "base", ["--memory", "8"]],
      ...(interrupt ? [] : [["mountCount", "base"]]),
    ]);
    const directory = stage();
    assert.ok(directory);
    assert.equal(existsSync(directory), false);
  },
);
