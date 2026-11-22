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

import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { profileNamed } from "../../gateway/control.ts";
import type { Instance } from "../../gateway/state.ts";
import { dotfilesRepo, guestLib, guestRepo } from "../config.ts";
import { CogError, Interrupted } from "../errors.ts";
import { gatewayName, sizeArgs, validName, validRepository } from "../names.ts";
import { note, say } from "../output.ts";
import {
  deleteTailscale,
  enrollTailscale,
  tailscaleCredential,
} from "../tailscale.ts";
import { signals } from "../proc.ts";
import { loadProfiles } from "../profiles.ts";
import {
  fireworksKeyPresent,
  readClaudeTokenFile,
  readCodexAuth,
  readFireworksKey,
  toBytes,
} from "../secrets.ts";
import type { LifecycleContext } from "./context.ts";
import { inferRepository } from "./lifecycle.ts";

type NewContext = LifecycleContext<
  | "boot"
  | "clone"
  | "directory"
  | "edit"
  | "enter"
  | "exists"
  | "guestHome"
  | "hasGatewaySocket"
  | "remove"
  | "shell"
  | "shellOutput",
  | "certificates"
  | "close"
  | "disable"
  | "ensureAuth"
  | "grant"
  | "health"
  | "state"
  | "register"
>;

function defaultName(now: Date): string {
  const pair = (value: number): string => String(value).padStart(2, "0");
  return `vm-${pair(now.getFullYear() % 100)}${pair(now.getMonth() + 1)}${pair(now.getDate())}-${pair(now.getHours())}${pair(now.getMinutes())}${pair(now.getSeconds())}`;
}

function parseArgs(args: readonly string[]): {
  name: string;
  repository: string | undefined;
  noRepo: boolean;
  noClaude: boolean;
  noCodex: boolean;
} {
  let name: string | undefined;
  let repository: string | undefined;
  let noRepo = false;
  let noClaude = false;
  let noCodex = false;
  const options = args.values();
  for (const argument of options) {
    switch (argument) {
      case "--repo":
        repository = options.next().value;
        if (repository === undefined) {
          throw new CogError("--repo needs OWNER/REPO");
        }
        break;
      case "--no-repo":
        noRepo = true;
        break;
      case "--no-claude-token":
        noClaude = true;
        break;
      case "--no-codex-auth":
        noCodex = true;
        break;
      default:
        if (argument.startsWith("--repo=")) {
          repository = argument.slice("--repo=".length);
        } else if (argument.startsWith("-")) {
          throw new CogError(`unknown option ${argument}`);
        } else if (name === undefined) {
          name = argument;
        } else {
          throw new CogError(
            "usage: cog new [NAME] [--repo OWNER/REPO | --no-repo] [--no-claude-token] [--no-codex-auth]",
          );
        }
    }
  }
  return {
    name: name ?? defaultName(new Date()),
    repository,
    noRepo,
    noClaude,
    noCodex,
  };
}

function cleanupNote(text: string): void {
  try {
    note(text);
  } catch {
    // A closed terminal cannot take a diagnostic but the VM still needs cleanup.
  }
}

const probe = (seconds: string, url: string): string[] => [
  "curl",
  "--fail",
  "--silent",
  "--show-error",
  "--max-time",
  seconds,
  "--noproxy",
  "*",
  "--output",
  "/dev/null",
  url,
];

export async function newVM(
  args: readonly string[],
  context: NewContext,
): Promise<number> {
  const {
    name: inputName,
    repository: explicitRepo,
    noRepo,
    noClaude,
    noCodex,
  } = parseArgs(args);
  const name = validName(inputName);
  const {
    base,
    githubWebUrl,
    cpus,
    memory,
    claudeTokenFile,
    codexAuthFile,
    fireworksKeyFile,
    promptInput,
  } = context.config;
  if (name === base || name === "cog-base") {
    throw new CogError(`${name} is the base VM; choose another name`);
  }
  if (noRepo && explicitRepo !== undefined) {
    throw new CogError("--repo and --no-repo exclude each other");
  }
  const repository =
    explicitRepo === undefined
      ? noRepo
        ? null
        : await inferRepository(githubWebUrl)
      : validRepository(explicitRepo);
  if (explicitRepo === undefined && repository !== null) {
    note(
      `cog: GitHub access for ${repository}, from the origin of this checkout (--no-repo gives none)`,
    );
  }
  const lima = context.lima;
  const gateway = context.gateway();
  try {
    await gateway.health();
  } catch {
    throw new CogError(
      "the GitHub gateway is not running; run ./install.sh in the cog checkout",
    );
  }
  // eslint-disable-next-line unicorn/no-declarations-before-early-exit -- Invalid sizes fail before querying Lima.
  const size = sizeArgs(cpus, memory);
  if (!(await lima.exists(base))) {
    throw new CogError(`${base} does not exist; run cog base first`);
  }
  if (await lima.exists(name)) {
    throw new CogError(`${name} already exists`);
  }
  const gatewayVM = gatewayName(name);
  if (gateway.state.tailscaleNode(gatewayVM)) {
    throw new CogError(
      `Tailscale cleanup is pending; run cog rm ${name} first`,
    );
  }
  const credential = tailscaleCredential(context.config.tailscaleFile);
  const codex = noCodex ? undefined : readCodexAuth(codexAuthFile);
  const fireworks = fireworksKeyPresent(fireworksKeyFile)
    ? readFireworksKey(fireworksKeyFile)
    : undefined;
  let claude: string | undefined;
  if (!noClaude) {
    if (existsSync(claudeTokenFile)) {
      claude = readClaudeTokenFile(claudeTokenFile);
    } else {
      claude = await context.prompt(
        promptInput,
        ", run cog claude-token once, or pass --no-claude-token",
      );
      note("cog: cog claude-token keeps the token for next time");
    }
  }
  if (repository !== null) {
    await gateway.ensureAuth(repository);
  }

  let ownsClone = false;
  let registeredId: string | undefined;
  let enrollment: Instance | undefined;
  let guestDir: string | undefined;
  signals.install();
  try {
    await lima.clone(base, name, size);
    ownsClone = true;
    let directory: string;
    try {
      directory = await lima.directory(name);
    } catch {
      signals.check();
      throw new CogError(`cannot find the Lima directory of ${name}`);
    }
    if (!path.isAbsolute(directory)) {
      throw new CogError(`invalid Lima directory for ${name}`);
    }
    const socketDirectory = path.join(directory, "sock");
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    if (!lstatSync(socketDirectory).isDirectory()) {
      throw new CogError(`invalid socket directory for ${name}`);
    }
    chmodSync(socketDirectory, 0o700);

    let registration: Instance;
    try {
      registration = await gateway.register(gatewayVM, directory);
      registeredId = registration.id;
    } catch {
      signals.check();
      throw new CogError(`cannot register ${name} with the GitHub gateway`);
    }
    signals.check();
    const { id, socket } = registration;
    const socketName = path.basename(socket);
    if (!/^github-[0-9a-f-]+\.sock$/.test(socketName)) {
      throw new CogError("the GitHub gateway returned an invalid socket");
    }
    const rule = {
      guestSocket: "/tmp/cog-github.sock",
      hostSocket: `{{.Dir}}/sock/${socketName}`,
      reverse: true,
    };
    await lima.edit(
      name,
      `.portForwards = ${JSON.stringify([rule])} + .portForwards`,
    );
    await lima.boot(name);
    await lima.shell(name, [
      "/home/linuxbrew/.linuxbrew/bin/brew",
      "upgrade",
      "--cask",
      "claude-code@latest",
      "codex",
    ]);

    const guestHome = await lima.guestHome(name);
    let ca: string;
    try {
      ca = gateway.certificates().ca;
    } catch {
      throw new CogError("cannot find the gateway CA certificate");
    }
    await lima.shell(name, ["sudo", `${guestLib}/setup-github-gateway`, id], {
      stdin: { file: ca },
    });
    await lima.shell(
      name,
      probe("10", "https://api.github.com/__cog__/health"),
    );

    let cloned = false;
    if (repository !== null) {
      const revision = await gateway.grant(gatewayVM, repository, () =>
        profileNamed(loadProfiles(context.config), "cog"),
      );
      signals.check();
      say(`policy revision ${String(revision)}`);
      await lima.shell(
        name,
        probe("20", `https://api.github.com/repos/${repository}`),
      );
      if (repository.toLowerCase() === dotfilesRepo) {
        guestDir = `${guestHome}/${guestRepo}`;
      } else {
        guestDir = `${guestHome}/src/github.com/${repository}`;
        await lima.shell(name, [
          "env",
          "GIT_TERMINAL_PROMPT=0",
          "git",
          "clone",
          "--quiet",
          `${githubWebUrl}/${repository}.git`,
          guestDir,
        ]);
        cloned = true;
      }
    }
    const secrets: readonly (readonly [string, Uint8Array | undefined])[] = [
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        claude === undefined ? undefined : toBytes(`${claude}\n`),
      ],
      ["CODEX_AUTH", codex],
      [
        "FIREWORKS_API_KEY",
        fireworks === undefined ? undefined : toBytes(`${fireworks}\n`),
      ],
    ];
    for (const [key, bytes] of secrets) {
      if (bytes !== undefined) {
        await lima.shell(name, [`${guestLib}/setup-secrets`, key], {
          stdin: bytes,
        });
      }
    }

    if (credential) {
      enrollment = registration;
      const address = await enrollTailscale(
        lima,
        gateway.state,
        credential,
        name,
        id,
      );
      say(`cog: SSH / Herdr: ${address}`);
    }
    say(`cog: ${name} is ready.`);
    if (repository === null || guestDir === undefined) {
      say(
        `cog: ${name} has no GitHub access; cog grant ${name} OWNER/REPO gives it some.`,
      );
    } else {
      const where = cloned
        ? `it is cloned at ${guestDir}`
        : `the checkout from ${base} is at ${guestDir}`;
      say(
        `cog: GitHub access: ${repository}, with reads and pushes to cog/${id}/*; ${where}.`,
      );
    }
    if (noClaude) {
      say(
        "cog: no Claude token was installed; run claude auth login in the VM.",
      );
    }
    if (noCodex) {
      say(
        "cog: Codex is not signed in; run\n\n    codex login --device-auth\n\nin the VM, after turning on device code login in ChatGPT's security settings.",
      );
    }
    signals.check();
    gateway.close();
  } catch (error) {
    if (!ownsClone) {
      throw error;
    }
    const status = signals.status;
    await signals.cleanup(async () => {
      if (enrollment) {
        const active = gateway.state.byName(gatewayVM);
        if (active && active.id !== enrollment.id) return;
      }
      cleanupNote(`cog: removing ${name} after the failure`);
      if (registeredId !== undefined) {
        try {
          await gateway.disable(gatewayVM);
        } catch {
          cleanupNote(
            `cog: could not disable GitHub access for ${name}; run: cog gateway disable ${name}`,
          );
        }
      }
      let deleted = false;
      try {
        if (
          !enrollment ||
          (await lima.hasGatewaySocket(name, enrollment.socket))
        ) {
          await lima.remove(name);
        }
        deleted = true;
      } catch {
        cleanupNote(
          `cog: could not delete ${name}; run: limactl delete --force ${name}`,
        );
      }
      if (registeredId !== undefined) {
        try {
          const record = gateway.state.tailscaleNode(gatewayVM);
          if (record?.instanceId === registeredId) {
            await deleteTailscale(context.config.tailscaleFile, record);
            if (deleted) {
              gateway.state.forgetTailscale(registeredId);
            }
          }
        } catch {
          cleanupNote(
            `cog: Tailscale cleanup is pending; retry with cog rm ${name}`,
          );
        }
      }
    });
    throw status === null ? error : new Interrupted(status);
  } finally {
    signals.uninstall();
  }
  return lima.enter(name, guestDir);
}
