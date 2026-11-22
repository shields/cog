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

import { Control, controlOptions, locations } from "../gateway/control.ts";
import { gatewayCommand } from "./commands/gateway.ts";
import type { Context } from "./commands/context.ts";
import { authorize, edit, logs, revoke, show } from "./commands/policy.ts";
import { loadConfig, type Config, type Env } from "./config.ts";
import { CogError, exitStatus } from "./errors.ts";
import { validName } from "./names.ts";
import { note, say } from "./output.ts";

function usage(config: Config): string {
  const { base, defaultDotfiles } = config;
  return `usage: cog base [--dotfiles DIR] [MODULE...]
                              build ${base} from lima/dev.yaml and guest/ of this cog and
                              the dotfiles checkout DIR
       cog new [NAME] [--repo OWNER/REPO | --no-repo] [--no-claude-token] [--no-codex-auth]
                              clone ${base}, install secrets, clone the repository, open a shell
       cog grant NAME [OWNER/REPO] [--profile read|cog]
                              grant a repository through the Mac gateway
       cog revoke NAME OWNER/REPO
                              take a repository's grant away
       cog show NAME          print the policy of a VM
       cog edit NAME          edit the policy of a VM in $VISUAL or $EDITOR
       cog logs NAME|VM-ID [--follow|--all]
                              print what a VM asked for and what the policy did
       cog authorize OWNER/REPO
                              run the GitHub App device flow for a repository
       cog gateway serve|health|disable NAME
                              the daemon that launchd runs, its health check, and
                              the removal of a VM's registration
       cog claude-token       keep the token that claude setup-token prints, for every later new
       cog rm NAME            delete a VM (${base} is refused)
       cog list               list the VMs

DIR defaults to ${defaultDotfiles} and is never taken from the current
directory. COG_CPUS and COG_MEMORY (in GiB) override the size in lima/dev.yaml,
and COG_BASE replaces the name ${base}. COG_GITHUB_CLIENT_ID,
COG_GITHUB_WEB_URL and COG_GITHUB_API_URL change the GitHub App authorization.
COG_PROFILES names a file of grant profiles in place of the built-in read and
cog profiles.
`;
}

const planned = new Set(["base", "new", "grant", "claude-token", "rm", "list"]);

async function dispatch(
  verb: string,
  args: string[],
  context: Context,
): Promise<number> {
  switch (verb) {
    case "help":
    case "-h":
    case "--help":
      say(usage(context.config).trimEnd());
      return 0;
    case "show":
      show(args, context);
      return 0;
    case "edit":
      await edit(args, context);
      return 0;
    case "revoke":
      revoke(args, context);
      return 0;
    case "logs":
      await logs(args, context);
      return 0;
    case "authorize":
      await authorize(args, context);
      return 0;
    case "gateway":
      await gatewayCommand(args, context);
      return 0;
    default:
      if (planned.has(verb)) {
        throw new CogError(`${verb} is not implemented yet`);
      }
      note(usage(context.config).trimEnd());
      return 2;
  }
}

async function main(argv: string[], env: Env): Promise<number> {
  let control: Control | undefined;
  try {
    const config = loadConfig(env);
    validName(config.base);
    const context: Context = {
      config,
      env,
      gateway: () => {
        control ??= new Control(locations(env), controlOptions(env));
        return control;
      },
    };
    const [verb, ...args] = argv;
    if (verb === undefined) {
      note(usage(config).trimEnd());
      return 2;
    }
    return await dispatch(verb, args, context);
  } catch (error) {
    try {
      note(`cog: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // The error stream is closed, and the status below says what failed.
    }
    return exitStatus(error);
  } finally {
    control?.close();
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
