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
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { RegistrationFailedHere, type Control } from "../../gateway/control.ts";
import {
  proxyAddress,
  proxyUrl,
  type ProxyStatus,
} from "../../gateway/proxy.ts";
import { macInstance } from "../../gateway/state.ts";
import { CogError } from "../errors.ts";
import { say } from "../output.ts";
import { toBytes, writeSecretFile } from "../secrets.ts";
import type { Context } from "./context.ts";
import { printLogs, type LogsOptions } from "./policy.ts";

const usage = "usage: cog proxy enable|disable|status|logs [--follow|--all]";
const daemonLog = "~/Library/Logs/dev.msrl.cog.gateway.err";

export type ProxyContext = Pick<Context, "gateway">;

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw new CogError(`cannot look at ${file}`);
  }
}

function remove(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    throw new CogError(`cannot remove ${file}`);
  }
}

async function daemonStatus(control: Control): Promise<ProxyStatus> {
  try {
    return await control.proxy();
  } catch (error) {
    throw new CogError(
      `cannot ask the gateway about the proxy: ${message(error)}`,
    );
  }
}

async function requirePool(control: Control): Promise<void> {
  let state: string;
  try {
    ({ state } = await control.pool());
  } catch (error) {
    throw new CogError(
      `cannot read the Claude pool state from the gateway: ${message(error)}`,
    );
  }
  if (state !== "usable") {
    throw new CogError(
      "the Claude pool has no usable account; see cog account status, and run cog account add claude NAME",
    );
  }
}

function wiring(control: Control): string {
  const { proxy, proxyCa } = control.location;
  return `Claude Code on this Mac uses the pool when it starts with
  HTTPS_PROXY set to the content of ${proxy}
  NODE_EXTRA_CA_CERTS=${proxyCa}
  CLAUDE_CODE_OAUTH_TOKEN=cog
The file holds the proxy's key: never print it or pass it as an argument.`;
}

function read(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function caIsPublished(control: Control): boolean {
  const { proxyCa, secrets } = control.location;
  const certificate = read(path.join(secrets, "ca.pem"));
  return certificate !== null && read(proxyCa)?.equals(certificate) === true;
}

// The Mac's Claude Code keeps the commands it runs out of ~/.config/secrets,
// and a Node or Bun program among them that cannot read the file that
// NODE_EXTRA_CA_CERTS names warns each time it makes a connection. The
// certificate is no secret, so a copy goes where they can read it.
function publishCa(control: Control): void {
  if (caIsPublished(control)) {
    return;
  }
  const { proxyCa, secrets } = control.location;
  const certificate = read(path.join(secrets, "ca.pem"));
  if (certificate === null) {
    throw new CogError(`cannot read ${path.join(secrets, "ca.pem")}`);
  }
  writeSecretFile(proxyCa, certificate);
}

async function enable(control: Control): Promise<void> {
  const file = control.location.proxy;
  // The gateway's answer is as old as its last refresh, so it counts only
  // while the file and the registration that it was started from are still
  // there.
  if (
    (await daemonStatus(control)).state === "listening" &&
    exists(file) &&
    control.state.byName(macInstance) !== null
  ) {
    publishCa(control);
    say(`the proxy is already enabled\n${wiring(control)}`);
    return;
  }
  await requirePool(control);
  // What an enable that did not finish left behind.
  if (control.state.byName(macInstance) !== null) {
    control.state.disable(macInstance, control.actor);
  }
  remove(file);
  writeSecretFile(
    file,
    toBytes(
      `${proxyUrl(randomBytes(32).toString("base64url"), control.proxyPort)}\n`,
    ),
  );
  try {
    await control.register(macInstance);
  } catch (error) {
    remove(file);
    throw new CogError(
      error instanceof RegistrationFailedHere
        ? `cannot register the Mac with the gateway: ${error.message}`
        : `the gateway did not take the Mac's registration: ${message(error)}; see ${daemonLog}`,
    );
  }
  const status = await daemonStatus(control);
  if (status.state !== "listening") {
    remove(file);
    await control.disable(macInstance);
    throw new CogError(
      `the gateway cannot serve the proxy: ${status.reason ?? "it is off"}; see ${daemonLog}`,
    );
  }
  publishCa(control);
  say(
    `the proxy is enabled on [${proxyAddress}]:${String(control.proxyPort)}\n${wiring(control)}`,
  );
}

async function disable(control: Control): Promise<void> {
  const file = control.location.proxy;
  const registered = control.state.byName(macInstance) !== null;
  if (!registered && !exists(file)) {
    throw new CogError("the proxy is not enabled");
  }
  remove(file);
  remove(control.location.proxyCa);
  try {
    await (registered ? control.disable(macInstance) : control.sync());
  } catch (error) {
    throw new CogError(
      `the proxy is disabled here, but the gateway was not told (${message(error)}); it closes the proxy when it next starts or syncs`,
    );
  }
  say("the proxy is disabled, and its key no longer works");
}

async function status(control: Control): Promise<void> {
  const answer = await daemonStatus(control);
  if (answer.state === "listening") {
    if (!caIsPublished(control)) {
      throw new CogError(
        `the proxy is unusable: ${control.location.proxyCa} is not the gateway's CA certificate; run cog proxy enable`,
      );
    }
    const instance = control.state.byName(macInstance);
    if (instance === null) {
      throw new CogError("the proxy is unusable: the Mac is not registered");
    }
    say(
      `listening on [${proxyAddress}]:${String(control.proxyPort)} as ${instance.id}`,
    );
  } else if (answer.state === "off") {
    say("off");
  } else {
    throw new CogError(
      `the proxy is unusable: ${answer.reason ?? "unknown reason"}`,
    );
  }
}

export async function proxyCommand(
  args: string[],
  context: ProxyContext,
  options?: LogsOptions,
): Promise<void> {
  const [verb, ...rest] = args;
  const control = context.gateway();
  if (verb === "logs") {
    const [mode, ...extra] = rest;
    if (
      extra.length > 0 ||
      (mode !== undefined && mode !== "--follow" && mode !== "--all")
    ) {
      throw new CogError(usage);
    }
    const instance = control.state.byName(macInstance);
    if (instance === null) {
      throw new CogError(
        "the proxy is not enabled; cog logs VM-ID prints what an earlier one served",
      );
    }
    await printLogs(control, instance, mode, options);
    return;
  }
  if (rest.length > 0) {
    throw new CogError(usage);
  }
  switch (verb) {
    case "enable":
      await enable(control);
      return;
    case "disable":
      await disable(control);
      return;
    case "status":
      await status(control);
      return;
    default:
      throw new CogError(usage);
  }
}
