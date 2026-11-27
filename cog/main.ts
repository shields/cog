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
import { proxyPort } from "../gateway/proxy.ts";
import { baseVM } from "./commands/base.ts";
import { cloudCommand } from "./commands/cloud.ts";
import { gatewayCommand } from "./commands/gateway.ts";
import type { Context } from "./commands/context.ts";
import { disable, grant, list, remove } from "./commands/lifecycle.ts";
import { newVM } from "./commands/new.ts";
import { accountCommand } from "./commands/account.ts";
import { authorize, edit, logs, revoke, show } from "./commands/policy.ts";
import { proxyCommand } from "./commands/proxy.ts";
import { dotfilesRepo, loadConfig, type Config, type Env } from "./config.ts";
import { CogError, exitStatus } from "./errors.ts";
import { createLima, findLimactl, type Lima } from "./lima.ts";
import { validName } from "./names.ts";
import { note, say } from "./output.ts";
import { configureTailscale } from "./tailscale.ts";
import { promptClaudeToken } from "./secrets.ts";

function usage(config: Config, env: Env): string {
  const { base, defaultDotfiles, codexAuthFile, fireworksKeyFile } = config;
  const proxyFile = locations(env).proxy;
  return `usage: cog base [--dotfiles DIR] [MODULE...]
                              build ${base} from lima/dev.yaml and guest/ of this cog and
                              the dotfiles checkout DIR
       cog new [NAME] [--repo OWNER/REPO | --no-repo] [--no-claude] [--no-codex]
                              clone ${base}, install secrets, clone the repository, open a shell
       cog tailscale config CLIENT-ID
                              configure automatic Tailscale SSH access to new VMs
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
       cog gateway serve|health
                              the daemon that launchd runs and its health check
       cog cloud config|authorize|new|list|show|start|logs|events|grant|revoke|rm
                              administer Cloudflare containers
       cog account add claude NAME | rm claude NAME | rename claude OLD NEW | list | status
                              keep Claude accounts in the gateway's pool
       cog proxy enable|disable|status|logs [--follow|--all]
                              let Claude Code on this Mac use the pool through the gateway
       cog disable NAME       cut a VM off from the gateway (GitHub and the models) for
                              good; there is no enable, and cog rm NAME then deletes it
       cog rm NAME            delete a VM (${base} is refused)
       cog list | ls          list the VMs

DIR defaults to ${defaultDotfiles} and is never taken from the current
directory. It must be the top level of a git checkout with provision.sh,
.claude/settings.json and tools/configure_codex.py, and its shell, Codex and git
hooks must read the markers that cog writes. MODULE is a Brewfile module for
provision.sh (dev by default).
COG_CPUS and COG_MEMORY (in GiB) override the size in lima/dev.yaml, and
COG_BASE replaces the name ${base}. For Lima, COG_GITHUB_CLIENT_ID,
COG_GITHUB_WEB_URL and COG_GITHUB_API_URL configure GitHub App authorization.
new checks anonymous access at the configured API URL. COG_GITHUB_WEB_URL
determines which origins cog recognizes and which host it uses to clone.
The gateway relays a VM's requests to github.com.

The repository is --repo's, or else the one that the git origin of the current
directory names, if the origin uses the configured GitHub host. new reads public
repositories anonymously and grants read-only access to a private repository.
Credentials stay on the Mac. new clones the repository in the VM at
~/src/github.com/OWNER/REPO (${dotfilesRepo} is already in ${base}), and opens
the shell there. --no-repo skips repository selection. To enable pushes to
cog/VM-ID/*, run cog grant NAME OWNER/REPO --profile cog on the Mac.

new gives the VM no Claude credential: its Claude Code reaches Anthropic through
the gateway, which uses an account from the pool that cog account add claude
keeps, and the VM holds only a placeholder. new fails when the pool has no
usable account. --no-claude does not wire Claude Code to the gateway (no pool
check, no mapping, no placeholder), for a VM that will use claude auth login.

new copies this Mac's Codex login, ${codexAuthFile}, into the VM, and
fails when there is none: run codex login here first, with
cli_auth_credentials_store = "file" in ~/.codex/config.toml, since with keyring
or auto the login is in the OS credential store and no file exists.
--no-codex does not copy it, for a VM that will use codex login --device-auth.

When ${fireworksKeyFile} exists, new asks the gateway whether it is usable,
wires api.fireworks.ai to the gateway and gives the VM only the placeholder
cog: the key stays on this Mac, where the gateway reads the file for each
request. new never reads it.

proxy enable makes the gateway listen on [::1]:${String(proxyPort)} for the Claude
Code that runs on this Mac, and writes the value for its HTTPS_PROXY, which
holds a key, to ${proxyFile}. Requests to
api.anthropic.com then use a pool account as a VM's do, and every other host is
tunnelled untouched. proxy disable stops that and makes the key useless.
`;
}

async function dispatch(
  verb: string,
  args: string[],
  context: Context,
): Promise<number> {
  switch (verb) {
    case "help":
    case "-h":
    case "--help":
      say(usage(context.config, context.env).trimEnd());
      return 0;
    case "base":
      await baseVM(args, context);
      return 0;
    case "tailscale":
      await configureTailscale(args, context.config);
      return 0;
    case "new":
      return await newVM(args, context);
    case "list":
    case "ls":
      await list(args, context);
      return 0;
    case "disable":
      await disable(args, context);
      return 0;
    case "rm":
      await remove(args, context);
      return 0;
    case "grant":
      if (context.env.COG_PROFILES) {
        throw new CogError(
          "unset COG_PROFILES and select a built-in grant profile (read or cog)",
        );
      }
      await grant(args, context);
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
    case "account":
      await accountCommand(args, context);
      return 0;
    case "proxy":
      await proxyCommand(args, context);
      return 0;
    case "cloud":
      say(JSON.stringify(await cloudCommand(args, context.config), null, 2));
      return 0;
    default:
      note(usage(context.config, context.env).trimEnd());
      return 2;
  }
}

async function main(argv: string[], env: Env): Promise<number> {
  let control: Control | undefined;
  let lima: Lima | undefined;
  try {
    const config = loadConfig(env);
    const [verb, ...args] = argv;
    if (verb !== "cloud") {
      validName(config.base);
    }
    if (verb === undefined) {
      note(usage(config, env).trimEnd());
      return 2;
    }
    const context: Context = {
      config,
      env,
      get lima() {
        lima ??= createLima(findLimactl());
        return lima;
      },
      prompt: promptClaudeToken,
      gateway: () => {
        control ??= new Control(locations(env), controlOptions(env));
        return control;
      },
    };
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
