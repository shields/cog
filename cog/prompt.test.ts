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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";

const fixture = path.join(import.meta.dirname, "prompt.fixture.ts");
const marker = "COG_TYPED_SECRET";

async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function echoes(terminal: string): Promise<boolean> {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  const child = Bun.spawn(["stty", "-a", flag, terminal], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.split(/[\s;]+/).includes("echo");
}

interface Session {
  directory: string;
  output: () => string;
  type: (text: string) => void;
  finished: () => Promise<number>;
  read: (name: string) => string;
}

async function session(): Promise<Session> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cog-prompt-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  let output = "";
  const child = Bun.spawn([process.execPath, fixture, directory], {
    env: { ...process.env, COG_PROMPT_INPUT: "" },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += Buffer.from(data).toString("latin1");
      },
    },
  });
  onTestFinished(() => {
    child.kill();
    child.terminal?.close();
  });
  await until(() => output.includes("then press Enter: "));
  const terminal = (): string =>
    readFileSync(path.join(directory, "tty"), "utf8");
  await until(() => existsSync(path.join(directory, "tty")));
  await until(async () => !(await echoes(terminal())));
  return {
    directory,
    output: () => output,
    type: (text) => {
      child.terminal?.write(text);
    },
    finished: () => child.exited,
    read: (name) => readFileSync(path.join(directory, name), "utf8"),
  };
}

function echoIsOn(stty: string): boolean {
  return stty.split(/[\s;]+/).includes("echo");
}

test("the prompt does not echo what is typed, and puts the terminal back", async () => {
  const typed = await session();
  typed.type(`${marker}\n`);
  assert.equal(await typed.finished(), 0);
  assert.equal(typed.read("result"), `token:${marker}`);
  assert.equal(typed.output().includes(marker), false, typed.output());
  assert.equal(echoIsOn(typed.read("stty")), true);
}, 60_000);

test("two words typed at the prompt are refused", async () => {
  const typed = await session();
  typed.type(`${marker} other\n`);
  assert.equal(await typed.finished(), 0);
  assert.equal(
    typed.read("result"),
    "error:the Claude token has spaces in it; paste only the token",
  );
  assert.equal(typed.output().includes(marker), false);
  assert.equal(echoIsOn(typed.read("stty")), true);
}, 60_000);

test("Control-C interrupts the prompt and puts the terminal back", async () => {
  const typed = await session();
  typed.type("\u{3}");
  assert.equal(await typed.finished(), 0);
  assert.equal(typed.read("result"), "interrupted:130");
  assert.equal(echoIsOn(typed.read("stty")), true);
}, 60_000);

test("end of input at the prompt is an empty token", async () => {
  const typed = await session();
  typed.type("\u{4}");
  assert.equal(await typed.finished(), 0);
  assert.match(typed.read("result"), /^error:the Claude token is empty/);
  assert.equal(echoIsOn(typed.read("stty")), true);
}, 60_000);
