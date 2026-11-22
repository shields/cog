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

import { writeSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));

function again(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EAGAIN"
  );
}

// Synchronous, so that the output is in place before a child writes after it
// and before the process is replaced by the final shell.
export function writeAll(descriptor: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(descriptor, bytes, offset);
    } catch (error) {
      if (!again(error)) {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 2);
    }
  }
}

export function say(text: string): void {
  writeAll(1, `${text}\n`);
}

export function note(text: string): void {
  writeAll(2, `${text}\n`);
}
