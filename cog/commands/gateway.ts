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
import { note, say } from "../output.ts";
import type { Context } from "./context.ts";

async function serve(args: string[], context: Context): Promise<void> {
  if (args.length > 0) {
    throw new CogError("usage: cog gateway serve");
  }
  // A signal with no handler ends the process wherever it is, and one that
  // arrives while the certificates are issued would leave their lock behind,
  // which blocks every later start.
  const { promise: stopped, resolve } = Promise.withResolvers<undefined>();
  const stop = (): void => {
    resolve(undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    // The daemon's sockets and files are private to the user. No other command
    // sets a umask, since limactl, git and tar run under the caller's.
    process.umask(0o077);
    const control = context.gateway();
    if (await control.daemonListening()) {
      throw new CogError(
        `a gateway is already running: ${control.location.admin} accepts connections`,
      );
    }
    control.ensureSocketDirectory();
    for (const instance of control.disableOutsideSocketDirectory()) {
      note(
        `cog: ${instance.name.replace(/^lima:/, "")} (${instance.id}) was registered by an older cog; its gateway access is disabled; run cog rm ${instance.name.replace(/^lima:/, "")} and make it again with cog new`,
      );
    }
    control.removeStaleSockets();
    const gateway = new Gateway(control.state, control.auth, {
      ...control.certificates(),
      adminSocket: control.location.admin,
      pool: control.location.pool,
      fireworksKeyFile: context.config.fireworksKeyFile,
    });
    await gateway.start();
    await stopped;
    await gateway.stop();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
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
    default:
      throw new CogError("usage: cog gateway serve|health");
  }
}
