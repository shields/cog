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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { compareCodeUnits } from "../gateway/policy.ts";
import { loadConfig } from "./config.ts";
import { CogError } from "./errors.ts";
import { loadProfiles } from "./profiles.ts";

function config(profilesFile = ""): ReturnType<typeof loadConfig> {
  return loadConfig({ HOME: "/h", COG_PROFILES: profilesFile });
}

test("the profiles are the embedded ones unless COG_PROFILES names a file", () => {
  assert.deepEqual(loadProfiles(config()), {
    read: { read: true, pushCogBranches: false },
    cog: { read: true, pushCogBranches: true },
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "cog-profiles-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "profiles.yaml");
  writeFileSync(
    file,
    "read: {read: true, pushCogBranches: false}\ncog: {read: true, pushCogBranches: false}\nextra: {read: true, pushCogBranches: true}\n",
  );
  const profiles = loadProfiles(config(file));
  assert.deepEqual(Object.keys(profiles).toSorted(compareCodeUnits), [
    "cog",
    "extra",
    "read",
  ]);
  assert.equal(profiles.cog?.pushCogBranches, false);
});

test("a file that cannot be read is refused without quoting its path", () => {
  assert.throws(
    () => loadProfiles(config("/nonexistent/profiles.yaml")),
    (error: unknown) =>
      error instanceof CogError && error.message === "cannot read COG_PROFILES",
  );
});

test("a file with a missing or invalid profile is refused", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cog-profiles-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "profiles.yaml");
  writeFileSync(file, "read: {read: true, pushCogBranches: false}\n");
  assert.throws(() => loadProfiles(config(file)), {
    message: "invalid COG_PROFILES; define valid read and cog profiles",
  });
  writeFileSync(file, 'read: ["not a real secret"');
  assert.throws(() => loadProfiles(config(file)), {
    message: "invalid COG_PROFILES; define valid read and cog profiles",
  });
});
