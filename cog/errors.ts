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

// The message of a CogError is a fixed text that never quotes the contents of
// a file or the message of a parse or spawn error, since those can hold a
// secret.
export class CogError extends Error {}

export class CommandFailed extends Error {
  readonly status: number;

  constructor(label: string, status: number) {
    super(`${label} failed with status ${String(status)}`);
    this.status = status;
  }
}

export class Interrupted extends Error {
  readonly status: number;

  constructor(status: number) {
    super("interrupted");
    this.status = status;
  }
}

export function exitStatus(error: unknown): number {
  return error instanceof CommandFailed || error instanceof Interrupted
    ? error.status
    : 1;
}
