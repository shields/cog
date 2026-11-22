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
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { writeAll } from "./output.ts";

test("writeAll writes every byte, however large", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cog-output-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "out");
  const descriptor = openSync(file, "w");
  try {
    writeAll(descriptor, "text, ");
    writeAll(descriptor, Uint8Array.from([0xff, 0x00, 0x0a]));
    writeAll(descriptor, "x".repeat(1_000_000));
  } finally {
    closeSync(descriptor);
  }
  const written = readFileSync(file);
  assert.equal(written.length, 6 + 3 + 1_000_000);
  assert.deepEqual([...written.subarray(6, 9)], [0xff, 0x00, 0x0a]);
});

// say and note go to descriptors 1 and 2 through the same synchronous path,
// and the first is in place before the second program writes.
test("say and note write in order with a child's output", async () => {
  const script = `
    const { say, note } = await import(process.env.COG_TEST_OUTPUT);
    say("one");
    note("two");
    Bun.spawnSync(["/bin/sh", "-c", "echo three; echo four >&2"], { stdout: "inherit", stderr: "inherit" });
    say("five");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      COG_TEST_OUTPUT: path.join(import.meta.dirname, "output.ts"),
    },
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(await child.exited, 0);
  assert.equal(out, "one\nthree\nfive\n");
  assert.equal(err, "two\nfour\n");
});
