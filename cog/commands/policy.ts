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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { required } from "../../gateway/control.ts";
import { CogError } from "../errors.ts";
import { gatewayName, validName } from "../names.ts";
import { say, writeAll } from "../output.ts";
import { runStatus, signals } from "../proc.ts";
import type { Context } from "./context.ts";

export function show(args: string[], context: Context): void {
  const [name, ...rest] = args;
  if (name === undefined || rest.length > 0) {
    throw new CogError("usage: cog show NAME");
  }
  writeAll(1, context.gateway().show(gatewayName(validName(name))));
}

export async function edit(args: string[], context: Context): Promise<void> {
  const [name, ...rest] = args;
  if (name === undefined || rest.length > 0) {
    throw new CogError("usage: cog edit NAME");
  }
  const gateway = context.gateway();
  const vm = gatewayName(validName(name));
  const { instance, document } = gateway.beginEdit(vm);
  const directory = mkdtempSync(path.join(os.tmpdir(), "cog-edit-"));
  const file = path.join(directory, "policy.yaml");
  signals.install();
  try {
    writeFileSync(file, document, { mode: 0o600 });
    const editor = context.env.VISUAL ?? context.env.EDITOR ?? "vi";
    const status = await runStatus(
      ["/bin/sh", "-c", `${editor} "$1"`, "cog-edit", file],
      { stdin: "inherit" },
    );
    if (status !== 0) {
      throw new CogError("editor failed; policy is unchanged");
    }
    const revision = await gateway.commitEdit(
      vm,
      instance,
      readFileSync(file, "utf8"),
    );
    say(`policy revision ${String(revision)}`);
  } finally {
    signals.uninstall();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function revoke(args: string[], context: Context): void {
  const [name, repository, ...rest] = args;
  if (name === undefined || repository === undefined || rest.length > 0) {
    throw new CogError("usage: cog revoke NAME OWNER/REPO");
  }
  const revision = context
    .gateway()
    .revoke(gatewayName(validName(name)), repository);
  say(`policy revision ${String(revision)}`);
}

export interface LogsOptions {
  readonly pause: () => Promise<void>;
  readonly emit: (line: string) => void;
}

const standardLogs: LogsOptions = {
  pause: () => delay(1000),
  emit: say,
};

// A request row that is printed before it finishes is printed again, with its
// outcome, when it has: a finished row has a duration, which `State.finish`
// always sets and `State.logDecision` never does.
export async function logs(
  args: string[],
  context: Context,
  options: LogsOptions = standardLogs,
): Promise<void> {
  const [selector, mode, ...rest] = args;
  if (
    selector === undefined ||
    rest.length > 0 ||
    (mode !== undefined && mode !== "--follow" && mode !== "--all")
  ) {
    throw new CogError("usage: cog logs NAME|VM-ID [--follow|--all]");
  }
  const gateway = context.gateway();
  const asName = gatewayName(selector);
  const lookup = gateway.state.byName(asName) ? asName : selector;
  const instance = gateway.findInstance(lookup);
  let seen = new Set<string>();
  const unfinished = new Set<string>();
  const limit = mode === "--all" ? -1 : 100;
  for (;;) {
    const entries = gateway.logs(instance, limit, [...unfinished]);
    for (const entry of entries) {
      const pending = entry.kind === "request" && unfinished.has(entry.id);
      if (pending ? entry.durationMs !== null : !seen.has(entry.id)) {
        options.emit(JSON.stringify({ ...entry, vm: instance.name }));
        if (entry.kind === "request") {
          if (entry.durationMs === null) {
            unfinished.add(entry.id);
          } else {
            unfinished.delete(entry.id);
          }
        }
      }
    }
    if (mode !== "--follow") {
      return;
    }
    seen = new Set(entries.map((entry) => entry.id));
    await options.pause();
  }
}

export async function authorize(
  args: string[],
  context: Context,
): Promise<void> {
  const [repository, ...rest] = args;
  if (repository === undefined || rest.length > 0) {
    throw new CogError("usage: cog authorize OWNER/REPO");
  }
  await context.gateway().authorize(required(repository, "repository"));
  say("GitHub authorization stored on the Mac");
}
