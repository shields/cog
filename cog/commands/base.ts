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

import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { guestLib, guestRepo } from "../config.ts";
import { CogError, CommandFailed } from "../errors.ts";
import { normalizeOrigin, sizeArgs } from "../names.ts";
import { note, say } from "../output.ts";
import { capture, run, runStatus, signals } from "../proc.ts";
import { writeResources } from "../resources.ts";
import type { LifecycleContext } from "./context.ts";

type BaseContext = LifecycleContext<
  | "create"
  | "exists"
  | "guestHome"
  | "isProtected"
  | "mountCount"
  | "pipeInto"
  | "protect"
  | "remove"
  | "setShell"
  | "shell"
  | "stop"
  | "unprotect"
>;

const markerReaders = [
  [".zshrc", "/etc/cog-throwaway"],
  [".zshrc", "/etc/cog-github-gateway"],
  [".zshenv", "/etc/cog-github-gateway"],
  [".zsh.d/wt.zsh", "/etc/cog-github-gateway"],
  [".codex/hooks/git_guard.py", "/etc/cog-github-gateway"],
  ["tools/configure_codex.py", "/etc/cog-throwaway"],
  ["provision.sh", "/etc/cog-github-gateway"],
] as const;

function parseArgs(
  args: readonly string[],
  defaultDotfiles: string,
): { directory: string; modules: string[] } {
  let directory: string | undefined;
  const modules: string[] = [];
  const options = args.values();
  for (const argument of options) {
    if (!argument.startsWith("-")) {
      modules.push(argument);
    } else if (modules.length > 0) {
      throw new CogError(`option ${argument} must come before the modules`);
    } else if (
      argument === "--dotfiles" ||
      argument.startsWith("--dotfiles=")
    ) {
      if (directory !== undefined) {
        throw new CogError("--dotfiles was given twice");
      }
      directory =
        argument === "--dotfiles"
          ? options.next().value
          : argument.slice("--dotfiles=".length);
      if (!directory) {
        throw new CogError("--dotfiles needs a directory");
      }
    } else {
      throw new CogError(`unknown option ${argument}`);
    }
  }
  return { directory: directory ?? defaultDotfiles, modules };
}

function need(program: string): string {
  const command = Bun.which(program);
  if (command === null) {
    throw new CogError(`${program} is not installed`);
  }
  return command;
}

function checkedFile(file: string, mode = 0): boolean {
  try {
    accessSync(file, mode);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

async function findDotfiles(
  git: string,
  directory: string,
): Promise<{ dotfiles: string; commit: string }> {
  let dotfiles: string;
  try {
    dotfiles = realpathSync(directory);
    if (!statSync(dotfiles).isDirectory()) {
      throw new CogError("not a directory");
    }
  } catch {
    throw new CogError(
      `the dotfiles checkout ${directory} does not exist; pass --dotfiles DIR`,
    );
  }
  let top: string;
  try {
    top = await capture([git, "-C", dotfiles, "rev-parse", "--show-toplevel"], {
      quiet: true,
    });
  } catch {
    throw new CogError(
      `${dotfiles} is not a git checkout; pass --dotfiles DIR`,
    );
  }
  if (top !== dotfiles) {
    throw new CogError(
      `${dotfiles} is not the top level of its git checkout; pass --dotfiles DIR`,
    );
  }
  if (
    !checkedFile(path.join(dotfiles, "provision.sh"), constants.X_OK) ||
    !checkedFile(path.join(dotfiles, ".claude/settings.json")) ||
    !checkedFile(path.join(dotfiles, "tools/configure_codex.py"))
  ) {
    throw new CogError(
      `${dotfiles} is not a dotfiles checkout (provision.sh, .claude/settings.json or tools/configure_codex.py is missing)`,
    );
  }
  try {
    const commit = await capture(
      [git, "-C", dotfiles, "rev-parse", "--verify", "HEAD"],
      { quiet: true },
    );
    return { dotfiles, commit };
  } catch {
    throw new CogError(`${dotfiles} has no commits`);
  }
}

function hasMarker(file: string, marker: string): boolean {
  try {
    return lstatSync(file).isFile() && readFileSync(file).includes(marker);
  } catch {
    return false;
  }
}

function checkMarkerReaders(tree: string): void {
  for (const [file, marker] of markerReaders) {
    if (!hasMarker(path.join(tree, file), marker)) {
      throw new CogError(
        `${file} in the dotfiles checkout does not name ${marker}, which cog writes; a checkout from before the split reads other markers, so update it`,
      );
    }
  }
}

function treeModes(directory: string, top = true): void {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (top && entry.name === ".git") {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      treeModes(file, false);
    } else if (entry.isFile()) {
      chmodSync(file, (lstatSync(file).mode & 0o111) === 0 ? 0o644 : 0o755);
    }
  }
}

function checkGuestScripts(guest: string): void {
  let files;
  try {
    files = readdirSync(guest, { recursive: true, withFileTypes: true });
  } catch {
    throw new CogError(
      "the embedded guest/ directory is missing or unreadable",
    );
  }
  for (const file of files) {
    if (!file.isFile() && !file.isDirectory()) {
      throw new CogError("guest/ may hold only regular files and directories");
    }
  }
  for (const name of [
    "configure-github-access.sh",
    "github-gateway-credential",
    "install-push-instructions.sh",
    "reset-identity.sh",
    "setup-github-gateway",
    "setup-model-gateway",
    "setup-secrets",
    "throwaway.sh",
  ]) {
    if (!checkedFile(path.join(guest, name), constants.X_OK)) {
      throw new CogError(
        `embedded guest/${name} is missing or is not executable`,
      );
    }
  }
}

async function scan(
  gitleaks: string,
  mode: "git" | "dir",
  directory: string,
  failure: string,
): Promise<void> {
  try {
    await run(
      [
        gitleaks,
        mode,
        "--no-banner",
        "--no-color",
        "--redact",
        "--verbose",
        "--log-level",
        "warn",
        ...(mode === "git" ? ["--log-opts=--all -m"] : []),
        "--gitleaks-ignore-path",
        directory,
        directory,
      ],
      { stdoutToStderr: true },
    );
  } catch (error) {
    if (!(error instanceof CommandFailed)) {
      throw error;
    }
    throw new CogError(failure);
  }
}

async function graftHistory(
  git: string,
  source: string,
  stage: string,
  tree: string,
): Promise<void> {
  const history = path.join(stage, "history");
  await run([
    git,
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    "--template=",
    source,
    history,
  ]);
  const head = await capture([
    git,
    "-C",
    history,
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const symbolic = await runStatus(
    [git, "-C", source, "symbolic-ref", "--quiet", "HEAD"],
    { quiet: true },
  );
  if (symbolic === 1) {
    await run([git, "-C", history, "update-ref", "--no-deref", "HEAD", head]);
  } else if (symbolic !== 0) {
    throw new CommandFailed("git symbolic-ref", symbolic);
  }
  rmSync(path.join(tree, ".git"), { recursive: true, force: true });
  renameSync(path.join(history, ".git"), path.join(tree, ".git"));
  await run([git, "-C", tree, "config", "core.ignorecase", "false"]);
  // Provisioning uses the index to include uncommitted files in the install.
  await run([
    git,
    "-C",
    tree,
    "-c",
    "core.excludesFile=/dev/null",
    "add",
    "-Af",
    ".",
  ]);
}

export async function baseVM(
  args: readonly string[],
  context: BaseContext,
  resources = writeResources,
): Promise<void> {
  const lima = context.lima;
  const git = need("git");
  const tar = need("tar");
  const gitleaks = need("gitleaks");
  const { base, cpus, memory, defaultDotfiles } = context.config;
  const { directory, modules } = parseArgs(args, defaultDotfiles);
  const size = sizeArgs(cpus, memory);
  const { dotfiles, commit } = await findDotfiles(git, directory);
  say(
    `cog: building ${base} from the dotfiles checkout ${dotfiles} at ${commit}`,
  );
  const rawOrigin = await capture(
    [
      git,
      "-C",
      dotfiles,
      "config",
      "--null",
      "--default",
      "",
      "--get",
      "remote.origin.url",
    ],
    { quiet: true },
  );
  if (!rawOrigin.endsWith("\0")) {
    throw new CogError("cannot query the dotfiles origin");
  }
  const origin = normalizeOrigin(rawOrigin.slice(0, -1));

  let stage: string | undefined;
  let started = false;
  let finished = false;
  signals.install();
  try {
    stage = mkdtempSync(path.join(os.tmpdir(), "cog."));
    chmodSync(stage, 0o700);
    const tree = path.join(stage, "tree");
    const embedded = resources(stage);
    await run([embedded.stageTree, "--source", dotfiles, tree], {
      label: "stage_tree.sh",
    });
    checkMarkerReaders(tree);
    treeModes(tree);
    checkGuestScripts(embedded.guest);
    await scan(
      gitleaks,
      "dir",
      embedded.guest,
      "gitleaks found secrets in guest/, or failed",
    );
    await graftHistory(git, dotfiles, stage, tree);
    // Removing a remote makes its unmerged branches unreachable by the scanner.
    await scan(
      gitleaks,
      "git",
      tree,
      "gitleaks found secrets in the repository history, or failed",
    );
    await run([
      git,
      "-C",
      tree,
      "remote",
      ...(origin === "" ? ["remove", "origin"] : ["set-url", "origin", origin]),
    ]);
    if (await lima.exists(base)) {
      if (await lima.isProtected(base)) {
        await lima.unprotect(base);
      }
      await lima.remove(base);
    }
    started = true;
    await lima.create(base, size, embedded.limaTemplate);
    const mounts = await lima.mountCount(base);
    if (mounts !== "0") {
      if (!/^[1-9][0-9]*$/.test(mounts)) {
        throw new CogError(`cannot determine the mount count of ${base}`);
      }
      throw new CogError(
        `${base} mounts ${mounts} host directories, which ~/.lima/_config adds; a throwaway VM mounts none`,
      );
    }
    const guestHome = await lima.guestHome(base);
    const guestDir = `${guestHome}/${guestRepo}`;
    const archive = (source: string): string[] => [
      tar,
      "--no-xattrs",
      "--no-acls",
      "-C",
      source,
      "-cf",
      "-",
      ".",
    ];
    const tarOptions = {
      producer: { env: { COPYFILE_DISABLE: "1" }, label: "tar" },
    };
    await lima.pipeInto(
      archive(tree),
      base,
      [
        "sh",
        "-c",
        'set -eu; rm -rf "$1"; mkdir -p "$1"; tar -xf - --no-same-owner -C "$1"',
        "_",
        guestDir,
      ],
      tarOptions,
    );

    await lima.shell(base, [
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
    ]);
    await lima.pipeInto(
      archive(embedded.guest),
      base,
      [
        "sudo",
        "tar",
        "-x",
        "--no-same-owner",
        "--no-same-permissions",
        "-C",
        guestLib,
      ],
      tarOptions,
    );
    await lima.shell(base, ["sudo", "chown", "-R", "root:root", guestLib]);
    await lima.shell(base, ["sudo", "chmod", "-R", "u=rwX,go=rX", guestLib]);

    const workdir = { workdir: guestDir };
    await lima.shell(base, ["./provision.sh", ...modules], workdir);
    await lima.shell(
      base,
      ["git", "reset", "--mixed", "--quiet", "HEAD"],
      workdir,
    );
    await lima.shell(base, [
      "sudo",
      `${guestLib}/throwaway.sh`,
      "--claude-settings",
      `${guestDir}/.claude/settings.json`,
    ]);
    await lima.shell(
      base,
      [
        "env",
        "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
        "uv",
        "run",
        "--no-dev",
        "python",
        "tools/configure_codex.py",
        `${guestHome}/.codex/config.toml`,
      ],
      workdir,
    );
    await lima.shell(base, [
      "sudo",
      "systemctl",
      "mask",
      "--now",
      "tailscaled.service",
    ]);
    await lima.shell(base, [
      "sudo",
      "test",
      "!",
      "-e",
      "/var/lib/tailscale/tailscaled.state",
    ]);
    await lima.shell(base, ["sudo", "truncate", "-s", "0", "/etc/machine-id"]);
    await lima.shell(base, [`${guestLib}/reset-identity.sh`]);

    await lima.stop(base);
    await lima.setShell(base, "/usr/bin/zsh");
    await lima.protect(base);
    signals.check();
    finished = true;
    say(`cog: ${base} is ready; make a VM with: cog new [NAME]`);
  } finally {
    try {
      if (stage !== undefined) {
        rmSync(stage, { recursive: true, force: true });
      }
      if (started && !finished) {
        note(
          `cog: building ${base} failed; it is left for inspection (limactl shell ${base}), and cog base replaces it`,
        );
      }
    } finally {
      signals.uninstall();
    }
  }
}
