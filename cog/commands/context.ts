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

import type { Control } from "../../gateway/control.ts";
import type { Config, Env } from "../config.ts";
import type { Lima } from "../lima.ts";
import type { promptClaudeToken } from "../secrets.ts";

// What a command needs. The gateway is opened on first use, so a command that
// does not touch it creates no directory.
export interface Context {
  readonly config: Config;
  readonly env: Env;
  readonly lima: Lima;
  readonly gateway: () => Control;
  readonly prompt: typeof promptClaudeToken;
}

export type LifecycleContext<
  L extends keyof Lima,
  G extends keyof Control = never,
> = Pick<Context, "config" | "prompt"> & {
  readonly lima: Pick<Lima, L>;
  readonly gateway: () => Pick<Control, G>;
};
