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
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, spyOn, test } from "bun:test";
import { keyFileLimit, readKeyFile } from "./key-file.ts";

const marker = "fw-made-up-one";

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-key-file-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fileHolding(content: string | Uint8Array): string {
  const file = path.join(scratch(), "key");
  writeFileSync(file, content);
  return file;
}

test("one word of visible ASCII is the key, with whitespace and carriage returns removed", () => {
  const punctuation = "!\"#$%&'()*+,-./:;<=>?@[]^_`{|}~";
  const cases: [string, string, string][] = [
    ["bare", marker, marker],
    ["newline", `${marker}\n`, marker],
    ["CRLF", `${marker}\r\n`, marker],
    ["surrounding whitespace", ` \t\n${marker}\v\f \n`, marker],
    ["a carriage return inside", "fw-made\r-up", "fw-made-up"],
    ["every visible character", punctuation, punctuation],
    ["the limit", `${"k".repeat(keyFileLimit - 1)}\n`, "k".repeat(4095)],
  ];
  for (const [name, content, expected] of cases) {
    assert.deepEqual(
      readKeyFile(fileHolding(content)),
      { kind: "key", key: expected },
      name,
    );
  }
});

test("anything else is unusable, and the reason holds none of the content", () => {
  const cases: [string, string | Uint8Array, string][] = [
    ["empty", "", "is empty"],
    ["whitespace only", " \r\n\t\n", "is empty"],
    ["two words", `${marker} other`, "holds more than one word"],
    ["two lines", `${marker}\nother\n`, "holds more than one word"],
    ["a tab inside", `${marker}\tother`, "holds more than one word"],
    ["a form feed inside", `${marker}\fother`, "holds more than one word"],
    [
      "a control character",
      `${marker}\u{1}`,
      "holds a character that is not visible ASCII",
    ],
    ["a NUL", `${marker}\0`, "holds a character that is not visible ASCII"],
    ["DEL", `${marker}\u{7F}`, "holds a character that is not visible ASCII"],
    [
      "a high byte",
      Uint8Array.from([0x61, 0xe9]),
      "holds a character that is not visible ASCII",
    ],
    ["utf8", `${marker}\u{E9}`, "holds a character that is not visible ASCII"],
    [
      "a non-breaking space",
      `${marker}\u{A0}`,
      "holds a character that is not visible ASCII",
    ],
    [
      "one byte too many",
      "k".repeat(keyFileLimit + 1),
      `is larger than ${String(keyFileLimit)} bytes`,
    ],
    [
      "padding past the limit",
      `${marker}${" ".repeat(keyFileLimit)}`,
      `is larger than ${String(keyFileLimit)} bytes`,
    ],
  ];
  for (const [name, content, reason] of cases) {
    const result = readKeyFile(fileHolding(content));
    assert.deepEqual(result, { kind: "unusable", reason }, name);
    assert.ok(!JSON.stringify(result).includes(marker), name);
  }
});

test("a link to a regular file is followed", () => {
  const directory = scratch();
  writeFileSync(path.join(directory, "real"), `${marker}\n`);
  symlinkSync(path.join(directory, "real"), path.join(directory, "link"));
  assert.deepEqual(readKeyFile(path.join(directory, "link")), {
    kind: "key",
    key: marker,
  });
});

test("a missing path and a dangling link are missing", () => {
  const directory = scratch();
  symlinkSync(path.join(directory, "nothing"), path.join(directory, "link"));
  assert.deepEqual(readKeyFile(path.join(directory, "absent")), {
    kind: "missing",
  });
  assert.deepEqual(readKeyFile(path.join(directory, "link")), {
    kind: "missing",
  });
});

test("a directory and a named pipe are not regular files, and the pipe is not waited for", () => {
  const directory = scratch();
  mkdirSync(path.join(directory, "folder"));
  const pipe = path.join(directory, "pipe");
  assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
  symlinkSync(pipe, path.join(directory, "link"));
  for (const file of ["folder", "pipe", "link"]) {
    assert.deepEqual(
      readKeyFile(path.join(directory, file)),
      { kind: "unusable", reason: "is not a regular file" },
      file,
    );
  }
});

test("a named pipe that replaces the file after the check is neither waited for nor read", () => {
  const directory = scratch();
  const regular = path.join(directory, "regular");
  writeFileSync(regular, marker);
  const pipe = path.join(directory, "pipe");
  assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
  const status = fs.statSync(regular);
  const check = spyOn(fs, "statSync").mockImplementation(() => status as never);
  // A blocking open of a pipe with no writer never returns, which would hang
  // the run instead of failing the test, so the open is made non-blocking
  // whatever the reader asked for and the flags it asked for are checked.
  const requested: number[] = [];
  const open = fs.openSync;
  const opening = spyOn(fs, "openSync").mockImplementation(((
    file: fs.PathLike,
    flags: number,
    mode?: fs.Mode,
  ) => {
    requested.push(flags);
    return open(file, flags | fs.constants.O_NONBLOCK, mode);
  }) as never);
  onTestFinished(() => {
    check.mockRestore();
    opening.mockRestore();
  });
  assert.deepEqual(readKeyFile(pipe), {
    kind: "unusable",
    reason: "is not a regular file",
  });
  assert.deepEqual(
    requested.map((flags) => flags & fs.constants.O_NONBLOCK),
    [fs.constants.O_NONBLOCK],
  );
});

test("a file that cannot be opened is unusable and names only the error code", () => {
  const directory = scratch();
  const file = path.join(directory, "key");
  writeFileSync(file, marker, { mode: 0 });
  const result = readKeyFile(file);
  if (process.getuid?.() === 0) {
    assert.equal(result.kind, "key");
    return;
  }
  assert.deepEqual(result, {
    kind: "unusable",
    reason: "cannot be read (EACCES)",
  });
});
