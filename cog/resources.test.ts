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
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { compareCodeUnits } from "../gateway/policy.ts";
import {
  guestFiles,
  limaTemplate,
  profilesYaml,
  stageTree,
  writeResources,
} from "./resources.ts";

const root = path.join(import.meta.dirname, "..");
const onDisk = (...parts: string[]): string =>
  readFileSync(path.join(root, ...parts), "utf8");

test("the embedded files are the files of the checkout", () => {
  assert.equal(limaTemplate, onDisk("lima", "dev.yaml"));
  assert.equal(profilesYaml, onDisk("profiles.yaml"));
  assert.equal(stageTree, onDisk("tools", "stage_tree.sh"));
  for (const file of guestFiles) {
    assert.equal(file.text, onDisk("guest", file.name), file.name);
  }
});

test("every file of guest/ is embedded", () => {
  const names = readdirSync(path.join(root, "guest"))
    .filter((name) => name !== "__pycache__")
    .toSorted(compareCodeUnits);
  assert.deepEqual(
    guestFiles.map((file) => file.name).toSorted(compareCodeUnits),
    names,
  );
});

test("the embedded text is text", () => {
  assert.match(limaTemplate, /\S/);
  assert.match(profilesYaml, /pushCogBranches/);
  assert.match(stageTree, /^#!\/bin\/bash/);
  for (const file of guestFiles) {
    assert.match(file.text, /^#!/, file.name);
  }
});

test.each([0o000, 0o022, 0o077])(
  "writeResources gives explicit modes under umask %o",
  (mask) => {
    const stage = mkdtempSync(path.join(os.tmpdir(), "cog-resources-"));
    onTestFinished(() => {
      rmSync(stage, { recursive: true, force: true });
    });
    const previous = process.umask(mask);
    let paths: ReturnType<typeof writeResources>;
    try {
      paths = writeResources(stage);
    } finally {
      process.umask(previous);
    }
    const mode = (file: string): number => statSync(file).mode & 0o777;
    assert.equal(mode(paths.guest), 0o755);
    assert.equal(mode(paths.limaTemplate), 0o644);
    assert.equal(mode(paths.stageTree), 0o755);
    assert.equal(readFileSync(paths.limaTemplate, "utf8"), limaTemplate);
    assert.equal(readFileSync(paths.stageTree, "utf8"), stageTree);
    for (const file of guestFiles) {
      const written = path.join(paths.guest, file.name);
      assert.equal(mode(written), 0o755, file.name);
      assert.equal(readFileSync(written, "utf8"), file.text);
    }
  },
);
