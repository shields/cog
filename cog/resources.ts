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

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import githubAppToken from "../guest/github_app_token.py" with { type: "text" };
import githubGatewayCredential from "../guest/github-gateway-credential" with { type: "text" };
import resetIdentity from "../guest/reset-identity.sh" with { type: "text" };
import setupGithubGateway from "../guest/setup-github-gateway" with { type: "text" };
import setupSecrets from "../guest/setup-secrets" with { type: "text" };
import throwaway from "../guest/throwaway.sh" with { type: "text" };
import limaTemplate from "../lima/dev.yaml" with { type: "text" };
import profilesYaml from "../profiles.yaml" with { type: "text" };
import stageTree from "../tools/stage_tree.sh" with { type: "text" };

export { limaTemplate, profilesYaml, stageTree };

export interface ResourceFile {
  readonly name: string;
  readonly text: string;
}

// guest/ as installed in the guest's /usr/local/lib/cog.
export const guestFiles: readonly ResourceFile[] = [
  { name: "github_app_token.py", text: githubAppToken },
  { name: "github-gateway-credential", text: githubGatewayCredential },
  { name: "reset-identity.sh", text: resetIdentity },
  { name: "setup-github-gateway", text: setupGithubGateway },
  { name: "setup-secrets", text: setupSecrets },
  { name: "throwaway.sh", text: throwaway },
];

function write(file: string, text: string, mode: number): void {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

// Writes the embedded files into a directory that the caller made private:
// DIRECTORY/dev.yaml, DIRECTORY/embedded/tools/stage_tree.sh and DIRECTORY/guest/*, with
// explicit modes, whatever the umask.
export function writeResources(directory: string): {
  limaTemplate: string;
  stageTree: string;
  guest: string;
} {
  const guest = path.join(directory, "guest");
  mkdirSync(guest, { mode: 0o755 });
  chmodSync(guest, 0o755);
  for (const file of guestFiles) {
    write(path.join(guest, file.name), file.text, 0o755);
  }
  // The stager refuses destinations in its own checkout.
  const tools = path.join(directory, "embedded", "tools");
  mkdirSync(tools, { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(tools), 0o700);
  chmodSync(tools, 0o700);
  const paths = {
    limaTemplate: path.join(directory, "dev.yaml"),
    stageTree: path.join(tools, "stage_tree.sh"),
    guest,
  };
  write(paths.limaTemplate, limaTemplate, 0o644);
  write(paths.stageTree, stageTree, 0o755);
  return paths;
}
