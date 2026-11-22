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

import { Gateway } from "../../gateway/server.ts";
import { CogError } from "../errors.ts";
import { gatewayName, validName } from "../names.ts";
import { say } from "../output.ts";
import type { Context } from "./context.ts";

async function serve(args: string[], context: Context): Promise<void> {
  if (args.length > 0) {
    throw new CogError("usage: cog gateway serve");
  }
  // The daemon's sockets and files are private to the user. No other command
  // sets a umask, since limactl, git and tar run under the caller's.
  process.umask(0o077);
  const control = context.gateway();
  const gateway = new Gateway(control.state, control.auth, {
    ...control.certificates(),
    adminSocket: control.location.admin,
  });
  await gateway.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      resolve();
    });
    process.once("SIGTERM", () => {
      resolve();
    });
  });
  await gateway.stop();
}

export async function gatewayCommand(
  args: string[],
  context: Context,
): Promise<void> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "serve":
      await serve(rest, context);
      return;
    case "health":
      if (rest.length > 0) {
        throw new CogError("usage: cog gateway health");
      }
      await context.gateway().health();
      say("ready");
      return;
    case "disable": {
      const [name, ...extra] = rest;
      if (name === undefined || extra.length > 0) {
        throw new CogError("usage: cog gateway disable NAME");
      }
      await context.gateway().disable(gatewayName(validName(name)));
      return;
    }
    default:
      throw new CogError("usage: cog gateway serve|health|disable NAME");
  }
}
