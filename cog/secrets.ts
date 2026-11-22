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

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { CogError, Interrupted } from "./errors.ts";
import { writeAll } from "./output.ts";

// A secret is held as a latin1 string, in which each character is one byte,
// so that what is read is what is sent, whatever the bytes are.
export function toBytes(secret: string): Uint8Array {
  return new Uint8Array(Buffer.from(secret, "latin1"));
}

const whitespace = " \t\n\v\f\r";

// One word: carriage returns dropped, the ends trimmed, nothing left empty and
// no whitespace inside. The messages are the caller's, since they differ by
// source.
export function setOneWord(
  line: string,
  empty: string,
  spaces: string,
): string {
  const text = line.replaceAll("\r", "");
  let start = 0;
  let end = text.length;
  while (start < end && whitespace.includes(text.charAt(start))) {
    start++;
  }
  while (end > start && whitespace.includes(text.charAt(end - 1))) {
    end--;
  }
  const word = text.slice(start, end);
  if (word === "") {
    throw new CogError(empty);
  }
  for (const character of word) {
    if (whitespace.includes(character)) {
      throw new CogError(spaces);
    }
  }
  return word;
}

// NUL bytes are dropped.
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1").replaceAll("\0", "");
}

function readable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function regularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readClaudeTokenFile(file: string): string {
  if (!regularFile(file)) {
    throw new CogError(
      `${file} is not a regular file; remove it, or pass --no-claude-token`,
    );
  }
  if (!readable(file)) {
    throw new CogError(
      `cannot read ${file}; run cog claude-token to replace it, or pass --no-claude-token`,
    );
  }
  return setOneWord(
    latin1(readFileSync(file)),
    `${file} is empty; run cog claude-token to replace it, or pass --no-claude-token`,
    `${file} holds more than one token; run cog claude-token to replace it`,
  );
}

// A dangling symbolic link counts as present, and then fails the read.
export function fireworksKeyPresent(file: string): boolean {
  if (existsSync(file)) {
    return true;
  }
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readFireworksKey(file: string): string {
  if (!regularFile(file)) {
    throw new CogError(`${file} is not a regular file; remove it`);
  }
  if (!readable(file)) {
    throw new CogError(`cannot read ${file}`);
  }
  return setOneWord(
    latin1(readFileSync(file)),
    `${file} is empty; put the key in it, or remove it`,
    `${file} holds more than one word; put only the key in it`,
  );
}

// The bytes that are validated are the bytes that are sent. A parse error is
// never reported, since it can quote the file.
export function readCodexAuth(file: string): Uint8Array {
  if (!existsSync(file)) {
    throw new CogError(
      `${file} does not exist; Codex keeps its login in the OS credential store when cli_auth_credentials_store in ~/.codex/config.toml is keyring or auto: set it to "file" and run codex login on this Mac, or pass --no-codex-auth`,
    );
  }
  if (!regularFile(file)) {
    throw new CogError(
      `${file} is not a regular file; remove it, or pass --no-codex-auth`,
    );
  }
  if (!readable(file)) {
    throw new CogError(
      `cannot read ${file}; run codex login on this Mac again, or pass --no-codex-auth`,
    );
  }
  if (statSync(file).size === 0) {
    throw new CogError(
      `${file} is empty; run codex login on this Mac again, or pass --no-codex-auth`,
    );
  }
  const bytes = new Uint8Array(readFileSync(file));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CogError(
      `${file} is not a JSON object; run codex login on this Mac again, or pass --no-codex-auth`,
    );
  }
  return bytes;
}

export function requireRegularOrAbsent(file: string): void {
  if (existsSync(file) && !regularFile(file)) {
    throw new CogError(`${file} is not a regular file; remove it first`);
  }
}

// The helper restores the terminal on a signal as well as on a normal end.
const hiddenRead = `saved=$(stty -g) || exit 1
trap 'stty "$saved"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stty -echo || exit 1
IFS= read -r line
printf %s "$line"`;

async function readHidden(promptText: string, orElse: string): Promise<string> {
  let terminal: number;
  try {
    terminal = openSync("/dev/tty", "r+");
  } catch {
    throw new CogError(
      `there is no terminal to ask for the Claude token; run in a terminal${orElse}`,
    );
  }
  try {
    writeAll(terminal, promptText);
    const helper = Bun.spawn(["/bin/sh", "-c", hiddenRead], {
      stdin: terminal,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = new Response(helper.stdout).arrayBuffer();
    const status = await helper.exited;
    writeAll(terminal, "\n");
    if (status === 129 || status === 130 || status === 143) {
      throw new Interrupted(status);
    }
    if (status !== 0) {
      throw new CogError("cannot read the Claude token from the terminal");
    }
    return latin1(new Uint8Array(await output));
  } finally {
    closeSync(terminal);
  }
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
}

// promptInput names a file to read instead of the terminal, for tests.
export async function promptClaudeToken(
  promptInput: string,
  orElse = "",
): Promise<string> {
  let line: string;
  if (promptInput === "") {
    line = firstLine(
      await readHidden(
        "Paste the output of claude setup-token (no echo), then press Enter: ",
        orElse,
      ),
    );
  } else {
    if (!readable(promptInput)) {
      throw new CogError("cannot read COG_PROMPT_INPUT");
    }
    try {
      line = firstLine(latin1(readFileSync(promptInput)));
    } catch {
      line = "";
    }
  }
  return setOneWord(
    line,
    `the Claude token is empty; run claude setup-token in another terminal and paste its output${orElse}`,
    "the Claude token has spaces in it; paste only the token",
  );
}

// The file appears complete and with mode 0600 or not at all, under any umask.
export function writeSecretFile(file: string, bytes: Uint8Array): void {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch {
    try {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      rmSync(temporary, { force: true });
    } catch {
      // The write failed first, and its error is the one that is reported.
    }
    throw new CogError(`cannot write ${file}`);
  }
}
