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
import { CogError } from "./errors.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const dotfilesRepo = "shields/dotfiles";
export const guestRepo = `src/github.com/${dotfilesRepo}`;
export const guestLib = "/usr/local/lib/cog";

export interface Config {
  readonly home: string;
  readonly base: string;
  readonly cpus: string;
  readonly memory: string;
  readonly githubWebUrl: string;
  readonly promptInput: string;
  readonly profilesFile: string;
  readonly claudeTokenFile: string;
  readonly fireworksKeyFile: string;
  readonly codexAuthFile: string;
  readonly defaultDotfiles: string;
}

// An empty variable counts as unset.
function setting(env: Env, name: string, fallback = ""): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

// HOME comes from the environment, never from the passwd entry, so that a
// missing HOME is an error and a test's HOME is honoured.
export function loadConfig(env: Env): Config {
  const home = setting(env, "HOME");
  if (home === "") {
    throw new CogError("HOME is not set");
  }
  return {
    home,
    base: setting(env, "COG_BASE", "cog-base"),
    cpus: setting(env, "COG_CPUS"),
    memory: setting(env, "COG_MEMORY"),
    githubWebUrl: setting(env, "COG_GITHUB_WEB_URL", "https://github.com"),
    promptInput: setting(env, "COG_PROMPT_INPUT"),
    profilesFile: setting(env, "COG_PROFILES"),
    claudeTokenFile: path.join(
      home,
      ".config",
      "secrets",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
    fireworksKeyFile: path.join(
      home,
      ".config",
      "secrets",
      "FIREWORKS_API_KEY",
    ),
    codexAuthFile: path.join(home, ".codex", "auth.json"),
    defaultDotfiles: path.join(home, "src", "github.com", dotfilesRepo),
  };
}
