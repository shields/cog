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

import path from "node:path";
import { readKeyFile } from "../../gateway/key-file.ts";
import { placeholderCredential } from "../../gateway/models.ts";
import { grantProfiles } from "../../gateway/policy.ts";
import {
  socketName,
  type Control,
  type PoolStatus,
} from "../../gateway/control.ts";
import type { Instance } from "../../gateway/state.ts";
import { dotfilesRepo, guestLib, guestRepo } from "../config.ts";
import { CogError, CommandFailed, Interrupted } from "../errors.ts";
import { gatewayName, sizeArgs, validName, validRepository } from "../names.ts";
import { note, say } from "../output.ts";
import {
  deleteTailscale,
  enrollTailscale,
  tailscaleCredential,
} from "../tailscale.ts";
import { signals } from "../proc.ts";
import { fireworksKeyPresent, readCodexAuth, toBytes } from "../secrets.ts";
import type { LifecycleContext } from "./context.ts";
import { inferRepository } from "./lifecycle.ts";

type NewContext = LifecycleContext<
  | "boot"
  | "clone"
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
  | "grant"
  | "health"
  | "location"
  | "pool"
  | "prepareRepository"
  | "state"
  | "sync"
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

async function requireUsablePool(
  gateway: Pick<Control, "pool" | "sync">,
): Promise<void> {
  const skip = "or pass --no-claude-token";
  let status: PoolStatus;
  try {
    // The gateway reads the pool directory when it starts and when it syncs,
    // so a bad entry that was fixed by hand counts only after a sync.
    await gateway.sync();
    status = await gateway.pool();
  } catch (error) {
    throw new CogError(
      `cannot read the Claude pool state from the gateway: ${error instanceof Error ? error.message : "unknown error"}, ${skip}`,
    );
  }
  if (status.state === "unconfigured") {
    throw new CogError(
      `the Claude pool has no account; run cog pool add NAME, ${skip}`,
    );
  }
  if (status.state === "unusable") {
    throw new CogError(
      `the Claude pool is not usable: ${status.reason ?? "unknown reason"}; fix that (cog pool rm NAME removes an account), ${skip}`,
    );
  }
}

// The key stays on the Mac: the gateway reads the file for each request, and
// the guest gets only the placeholder. The messages never quote the file.
function requireUsableFireworksKey(file: string): void {
  const result = readKeyFile(file);
  if (result.kind === "key") {
    return;
  }
  throw new CogError(
    result.kind === "missing"
      ? `${file} is not a regular file; remove it`
      : `${file} ${result.reason}; fix it or remove it`,
  );
}

// Lima expands "{{" in a host socket and passes the path to ssh, which expands
// "%" and "${" in it and reads ":" as the end of the path, so a path that holds
// one would name a different socket or none.
const limaUnsafe = /\{\{|[%$:]/u;

function requireLimaSafe(location: string): void {
  const found = limaUnsafe.exec(location)?.[0];
  if (found !== undefined) {
    throw new CogError(
      `the gateway's socket location ${location} contains "${found}", which Lima or ssh would read as something else; use a state directory without it`,
    );
  }
}

function requireLimaSocket(socket: string, directory: string): void {
  if (
    !path.isAbsolute(socket) ||
    path.dirname(socket) !== directory ||
    !socketName.test(path.basename(socket))
  ) {
    throw new CogError("the GitHub gateway returned an invalid socket");
  }
}

// The messages that the registration raises in this process, and that hold
// nothing but fixed text. Any other failure is told only by the daemon's log.
const registrationRefusals = new Set([
  "VM is already registered",
  "the state directory is too long for a Unix socket",
]);

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
  const { base, githubWebUrl, cpus, memory, codexAuthFile, fireworksKeyFile } =
    context.config;
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
      `cog: using ${repository} from the origin of this checkout (--no-repo skips it)`,
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
  requireLimaSafe(gateway.location.sockets);
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
  const fireworks = fireworksKeyPresent(fireworksKeyFile);
  if (fireworks) {
    requireUsableFireworksKey(fireworksKeyFile);
  }
  if (!noClaude) {
    await requireUsablePool(gateway);
  }
  const access =
    repository === null
      ? "anonymous"
      : await gateway.prepareRepository(repository);

  let ownsClone = false;
  let registeredId: string | undefined;
  let enrollment: Instance | undefined;
  let guestDir: string | undefined;
  signals.install();
  try {
    await lima.clone(base, name, size);
    ownsClone = true;
    let registration: Instance;
    try {
      registration = await gateway.register(gatewayVM);
      registeredId = registration.id;
    } catch (error) {
      signals.check();
      throw new CogError(
        error instanceof Error && registrationRefusals.has(error.message)
          ? `cannot register ${name} with the GitHub gateway: ${error.message}`
          : `cannot register ${name} with the GitHub gateway; see ~/Library/Logs/dev.msrl.cog.gateway.err`,
      );
    }
    signals.check();
    const { id, socket } = registration;
    requireLimaSocket(socket, gateway.location.sockets);
    const rule = {
      guestSocket: "/tmp/cog-github.sock",
      hostSocket: socket,
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
    const models = [
      ...(noClaude ? [] : ["claude"]),
      ...(fireworks ? ["fireworks"] : []),
    ];
    if (models.length > 0) {
      try {
        await lima.shell(name, [
          "sudo",
          `${guestLib}/setup-model-gateway`,
          ...models,
        ]);
        if (!noClaude) {
          await lima.shell(
            name,
            probe("10", "https://api.anthropic.com/__cog__/health"),
          );
        }
        if (fireworks) {
          await lima.shell(
            name,
            probe("10", "https://api.fireworks.ai/__cog__/health"),
          );
        }
      } catch (error) {
        if (!(error instanceof CommandFailed)) {
          throw error;
        }
        const gatewayAge = fireworks
          ? ", or the running gateway is older than this cog, so run ./install.sh"
          : "";
        throw new CogError(
          `${name} cannot reach ${models.length > 1 ? "Claude and Fireworks" : noClaude ? "Fireworks" : "Claude"} through the gateway; a base built by an older cog lacks this wiring, so run cog base again${gatewayAge}`,
        );
      }
    }

    let cloned = false;
    if (repository !== null) {
      if (access === "authenticated") {
        const revision = await gateway.grant(
          gatewayVM,
          repository,
          grantProfiles.read,
        );
        signals.check();
        say(`policy revision ${String(revision)}`);
        await lima.shell(
          name,
          probe("20", `https://api.github.com/repos/${repository}`),
        );
      }
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
        noClaude ? undefined : toBytes(`${placeholderCredential}\n`),
      ],
      ["CODEX_AUTH", codex],
      [
        "FIREWORKS_API_KEY",
        fireworks ? toBytes(`${placeholderCredential}\n`) : undefined,
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
      say(`cog: ${name} can read public GitHub repositories anonymously.`);
    } else {
      const checkout = cloned ? "cloned" : `from ${base}`;
      say(`cog: ${repository} at ${guestDir} (${checkout}, ${access} reads).`);
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
