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

// Runs under a pseudo-terminal in secrets.test.ts: asks for the Claude token,
// then records the result and the terminal's settings in DIRECTORY.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { CogError, Interrupted } from "./errors.ts";
import { signals } from "./proc.ts";
import { promptClaudeToken } from "./secrets.ts";

const directory = process.argv[2] ?? "";
const record = (name: string, text: string): void => {
  writeFileSync(path.join(directory, name), text);
};

signals.install();
record(
  "tty",
  Bun.spawnSync(["tty"], { stdin: "inherit" }).stdout.toString().trim(),
);
try {
  record("result", `token:${await promptClaudeToken("")}`);
} catch (error) {
  if (error instanceof Interrupted) {
    record("result", `interrupted:${String(error.status)}`);
  } else if (error instanceof CogError) {
    record("result", `error:${error.message}`);
  } else {
    throw error;
  }
}
record(
  "stty",
  Bun.spawnSync(["stty", "-a"], { stdin: "inherit" }).stdout.toString(),
);
