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

import { grantProfiles, type Profile } from "../../gateway/policy.ts";
import { CogError, CommandFailed } from "../errors.ts";
import {
  gatewayName,
  githubHost,
  originRepository,
  validName,
  validRepository,
} from "../names.ts";
import { note, say } from "../output.ts";
import { capture, run } from "../proc.ts";
import { deleteTailscale } from "../tailscale.ts";
import type { LifecycleContext } from "./context.ts";

export async function inferRepository(webUrl: string): Promise<string | null> {
  const git = Bun.which("git");
  if (git === null) {
    throw new CogError("git is not installed");
  }
  try {
    await capture([git, "rev-parse", "--show-toplevel"], { quiet: true });
    const url = await capture([git, "remote", "get-url", "origin"], {
      quiet: true,
    });
    const repository = originRepository(url, webUrl);
    if (repository !== null) {
      try {
        validRepository(repository);
      } catch {
        throw new CogError("the git origin does not name a valid OWNER/REPO");
      }
    }
    return repository;
  } catch (error) {
    if (!(error instanceof CommandFailed)) {
      throw error;
    }
    return null;
  }
}

export async function list(
  args: readonly string[],
  context: LifecycleContext<"list">,
): Promise<void> {
  if (args.length !== 0) {
    throw new CogError("usage: cog list");
  }
  await context.lima.list();
}

export async function remove(
  args: readonly string[],
  context: LifecycleContext<"remove" | "hasGatewaySocket", "disable" | "state">,
): Promise<void> {
  const [first, ...rest] = args;
  if (first === undefined || rest.length !== 0) {
    throw new CogError("usage: cog rm NAME");
  }
  const name = validName(first);
  const { base } = context.config;
  if (name === base || name === "cog-base") {
    throw new CogError(`refusing to delete ${name}; cog base rebuilds it`);
  }
  const lima = context.lima;
  const gateway = context.gateway();
  const record = await gateway.disable(gatewayName(name), { forRemoval: true });
  if (record) {
    if (await lima.hasGatewaySocket(name, record.socket)) {
      await lima.remove(name);
    }
    await deleteTailscale(context.config.tailscaleFile, record);
    gateway.state.forgetTailscale(record.instanceId);
    say(
      `cog: removed the Tailscale device for ${name} and disabled its GitHub grants.`,
    );
    return;
  }
  await lima.remove(name);
  say(`cog: ${name} is deleted and its GitHub grants are disabled.`);
}

const grantUsage = "usage: cog grant NAME [OWNER/REPO] [--profile read|cog]";

function parseGrant(args: readonly string[]): {
  name: string;
  repository: string;
  profile: Profile;
} {
  const [name, ...rest] = args;
  if (name === undefined) {
    throw new CogError(grantUsage);
  }
  let repository: string | undefined;
  let profile: Profile | undefined;
  const options = rest.values();
  for (const argument of options) {
    if (argument === "--profile" || argument.startsWith("--profile=")) {
      if (profile !== undefined) {
        throw new CogError(grantUsage);
      }
      const value =
        argument === "--profile"
          ? options.next().value
          : argument.slice("--profile=".length);
      if (value !== "read" && value !== "cog") {
        throw new CogError(grantUsage);
      }
      profile = value;
    } else if (argument.startsWith("-") || repository !== undefined) {
      throw new CogError(grantUsage);
    } else {
      repository = argument;
    }
  }
  return { name, repository: repository ?? "", profile: profile ?? "cog" };
}

export async function grant(
  args: readonly string[],
  context: LifecycleContext<"exists", "grant">,
): Promise<void> {
  const {
    name: inputName,
    repository: inputRepository,
    profile,
  } = parseGrant(args);
  const name = validName(inputName);
  const { base, githubWebUrl } = context.config;
  if (name === base || name === "cog-base") {
    throw new CogError(`${name} is the base VM; it gets no GitHub access`);
  }
  let repository = inputRepository;
  if (repository === "") {
    const inferred = await inferRepository(githubWebUrl);
    if (inferred === null) {
      throw new CogError(
        `the current directory has no git origin on ${githubHost(githubWebUrl)}; run cog grant ${name} OWNER/REPO`,
      );
    }
    repository = inferred;
    note(
      `cog: GitHub access for ${repository}, from the origin of this checkout`,
    );
  }
  validRepository(repository);
  if (!(await context.lima.exists(name))) {
    throw new CogError(`${name} does not exist`);
  }
  const revision = await context
    .gateway()
    .grant(
      gatewayName(name),
      repository,
      grantProfiles[profile],
      async (userCode, verificationUri) => {
        await run(["pbcopy"], { stdin: Buffer.from(userCode), quiet: true });
        note(
          `cog: Paste the copied code ${userCode} at ${verificationUri} to authorize ${repository}.`,
        );
        await run(["open", verificationUri]);
      },
    );
  say(`policy revision ${String(revision)}`);
  say(
    `cog: ${name} can now ${profile === "cog" ? "read and push cog branches on" : "read"} ${repository}.`,
  );
}
