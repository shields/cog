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
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  Control,
  controlOptions,
  locations,
  parseProfiles,
  profileNamed,
  required,
} from "./control.ts";
import { Gateway } from "./server.ts";

async function command(arguments_: string[]): Promise<void> {
  const [verb, ...args] = arguments_;
  const location = locations(process.env);
  process.umask(0o077);
  const control = new Control(location, controlOptions(process.env));
  try {
    switch (verb) {
      case "serve": {
        if (args.length !== 0) {
          throw new Error("usage: cog-gateway serve");
        }
        const gateway = new Gateway(control.state, control.auth, {
          ...control.certificates(),
          adminSocket: location.admin,
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
        return;
      }
      case "init": {
        control.certificates();
        process.stdout.write("GitHub gateway certificates are ready\n");
        return;
      }
      case "ca-path": {
        process.stdout.write(`${control.certificates().ca}\n`);
        return;
      }
      case "health": {
        await control.health();
        process.stdout.write("ready\n");
        return;
      }
      case "register": {
        if (args.length !== 3 || args[1] !== "--lima-dir") {
          throw new Error(
            "usage: cog-gateway register lima:NAME --lima-dir PATH",
          );
        }
        const name = required(args[0], "VM name");
        const limaDirectory = required(args[2], "Lima instance directory");
        const instance = await control.register(name, limaDirectory);
        process.stdout.write(`${JSON.stringify(instance)}\n`);
        return;
      }
      case "disable": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway disable lima:NAME");
        }
        await control.disable(required(args[0], "VM name"));
        return;
      }
      case "authorize": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway authorize OWNER/REPO");
        }
        await control.authorize(required(args[0], "repository"));
        process.stdout.write("GitHub authorization stored on the Mac\n");
        return;
      }
      case "ensure-auth": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway ensure-auth OWNER/REPO");
        }
        await control.ensureAuth(required(args[0], "repository"));
        return;
      }
      case "grant": {
        if (args.length !== 4 || args[2] !== "--profile") {
          throw new Error(
            "usage: cog-gateway grant lima:NAME OWNER/REPO --profile read|cog",
          );
        }
        const name = required(args[0], "VM name");
        const profileName = required(args[3], "profile");
        const revision = await control.grant(
          name,
          required(args[1], "repository"),
          () =>
            profileNamed(
              parseProfiles(readFileSync(location.profiles, "utf8")),
              profileName,
            ),
        );
        process.stdout.write(`policy revision ${String(revision)}\n`);
        return;
      }
      case "revoke": {
        if (args.length !== 2) {
          throw new Error("usage: cog-gateway revoke lima:NAME OWNER/REPO");
        }
        const revision = control.revoke(
          required(args[0], "VM name"),
          required(args[1], "repository"),
        );
        process.stdout.write(`policy revision ${String(revision)}\n`);
        return;
      }
      case "show": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway show lima:NAME");
        }
        process.stdout.write(control.show(required(args[0], "VM name")));
        return;
      }
      case "edit": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway edit lima:NAME");
        }
        const name = required(args[0], "VM name");
        const { instance, document } = control.beginEdit(name);
        const directory = mkdtempSync(path.join(os.tmpdir(), "cog-edit-"));
        const file = path.join(directory, "policy.yaml");
        try {
          writeFileSync(file, document, { mode: 0o600 });
          const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
          const edited = spawnSync(
            "/bin/sh",
            ["-c", `${editor} "$1"`, "cog-edit", file],
            { stdio: "inherit" },
          );
          if (edited.status !== 0) {
            throw new Error("editor failed; policy is unchanged");
          }
          const revision = await control.commitEdit(
            name,
            instance,
            readFileSync(file, "utf8"),
          );
          process.stdout.write(`policy revision ${String(revision)}\n`);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        return;
      }
      case "logs": {
        if (
          args.length < 1 ||
          args.length > 2 ||
          (args[1] !== undefined &&
            args[1] !== "--follow" &&
            args[1] !== "--all")
        ) {
          throw new Error(
            "usage: cog-gateway logs lima:NAME|VM-ID [--follow|--all]",
          );
        }
        const selector = required(args[0], "VM name or ID");
        const instance = control.findInstance(selector);
        let seen = new Set<string>();
        const limit = args[1] === "--all" ? -1 : 100;
        for (;;) {
          const entries = control.logs(instance, limit);
          for (const entry of entries) {
            if (!seen.has(entry.id)) {
              process.stdout.write(
                `${JSON.stringify({ ...entry, vm: instance.name })}\n`,
              );
              seen.add(entry.id);
            }
          }
          if (args[1] !== "--follow") {
            break;
          }
          seen = new Set(entries.map((entry) => entry.id));
          await delay(1000);
        }
        return;
      }
      default:
        throw new Error(
          "usage: cog-gateway {serve|init|ca-path|health|register|disable|authorize|ensure-auth|grant|revoke|show|edit|logs}",
        );
    }
  } finally {
    control.close();
  }
}

try {
  await command(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `cog-gateway: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
