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

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";

export const keyFileLimit = 4096;

// A reason never holds the file's content or any part of it.
export type KeyFileResult =
  | { kind: "key"; key: string }
  | { kind: "missing" }
  | { kind: "unusable"; reason: string };

const whitespace = " \t\n\v\f\r";
const innerWhitespace = /[ \t\n\v\f]/u;
const visibleWord = /^[!-~]+$/u;

function unusable(reason: string): KeyFileResult {
  return { kind: "unusable", reason };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)
    ? code
    : "an error";
}

function trimmed(text: string): string {
  const withoutReturns = text.replaceAll("\r", "");
  let start = 0;
  let end = withoutReturns.length;
  while (start < end && whitespace.includes(withoutReturns.charAt(start))) {
    start++;
  }
  while (end > start && whitespace.includes(withoutReturns.charAt(end - 1))) {
    end--;
  }
  return withoutReturns.slice(start, end);
}

// The file is opened without blocking so that a named pipe put in its place
// cannot stall the caller.
export function readKeyFile(file: string): KeyFileResult {
  let descriptor: number;
  try {
    if (!statSync(file).isFile()) {
      return unusable("is not a regular file");
    }
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? { kind: "missing" }
      : unusable(`cannot be read (${errorCode(error)})`);
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      return unusable("is not a regular file");
    }
    const buffer = Buffer.alloc(keyFileLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) {
        break;
      }
      length += count;
    }
    if (length > keyFileLimit) {
      return unusable(`is larger than ${String(keyFileLimit)} bytes`);
    }
    const word = trimmed(buffer.subarray(0, length).toString("latin1"));
    if (word === "") {
      return unusable("is empty");
    }
    if (innerWhitespace.test(word)) {
      return unusable("holds more than one word");
    }
    if (!visibleWord.test(word)) {
      return unusable("holds a character that is not visible ASCII");
    }
    return { kind: "key", key: word };
  } catch (error) {
    return unusable(`cannot be read (${errorCode(error)})`);
  } finally {
    closeSync(descriptor);
  }
}
