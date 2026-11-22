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

import { readFileSync } from "node:fs";
import { parseProfiles } from "../gateway/control.ts";
import type { Grant } from "../gateway/policy.ts";
import type { Config } from "./config.ts";
import { CogError } from "./errors.ts";
import { profilesYaml } from "./resources.ts";

// The profiles embedded in the program, unless COG_PROFILES names a file.
export function loadProfiles(config: Config): Record<string, Grant> {
  if (config.profilesFile === "") {
    return parseProfiles(profilesYaml);
  }
  let text: string;
  try {
    text = readFileSync(config.profilesFile, "utf8");
  } catch {
    throw new CogError("cannot read COG_PROFILES");
  }
  return parseProfiles(text);
}
