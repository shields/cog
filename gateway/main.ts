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

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";
import { AppAuth } from "./auth.ts";
import { ensureCertificates } from "./cert.ts";
import {
  compareCodeUnits,
  normalizeRepository,
  parseGrant,
  parseGrants,
  taskPrefix,
  type Grant,
} from "./policy.ts";
import { Gateway } from "./server.ts";
import { State, type Instance } from "./state.ts";

interface Locations {
  state: string;
  secrets: string;
  admin: string;
  profiles: string;
}

function locations(): Locations {
  const root = process.env.COG_ROOT;
  if (root) {
    return {
      state: path.join(root, "state"),
      secrets: path.join(root, "secrets"),
      admin: path.join(root, "state", "admin.sock"),
      profiles: process.env.COG_PROFILES ?? path.join(root, "profiles.yaml"),
    };
  }
  const home = os.homedir();
  const state = path.join(home, ".local", "state", "cog");
  return {
    state,
    secrets: path.join(home, ".config", "secrets", "cog"),
    admin: path.join(state, "admin.sock"),
    profiles:
      process.env.COG_PROFILES ??
      path.join(home, ".config", "cog", "profiles.yaml"),
  };
}

function required(value: string | undefined, description: string): string {
  if (!value) {
    throw new Error(`missing ${description}`);
  }
  return value;
}

function active(state: State, name: string): Instance {
  const instance = state.byName(name);
  if (!instance || instance.disabled) {
    throw new Error(`${name} is not a registered VM`);
  }
  return instance;
}

function parseProfiles(file: string): Record<string, Grant> {
  const document = YAML.parseDocument(readFileSync(file, "utf8"), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid profile definitions: ${document.errors[0]?.message ?? "unknown error"}`,
    );
  }
  const raw = document.toJS() as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("profiles must be a mapping");
  }
  const profiles: Record<string, Grant> = {};
  for (const [name, input] of Object.entries(raw as Record<string, unknown>)) {
    const grant = /^[a-z][a-z0-9-]*$/.test(name) ? parseGrant(input) : null;
    if (!grant) {
      throw new Error(`invalid profile ${name}`);
    }
    profiles[name] = grant;
  }
  if (!profiles.read || !profiles.task) {
    throw new Error("read and task profiles are required");
  }
  return profiles;
}

function policyDocument(state: State, instance: Instance): string {
  return YAML.stringify({
    vm: instance.name,
    id: instance.id,
    revision: instance.revision,
    branchPrefix: taskPrefix(instance.id).replace(/^refs\/heads\//, ""),
    repositories: state.grants(instance.id),
  });
}

function parseEdit(
  content: string,
  instance: Instance,
): { revision: number; repositories: Record<string, Grant> } {
  const document = YAML.parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid policy YAML: ${document.errors[0]?.message ?? "unknown error"}`,
    );
  }
  const raw = document.toJS() as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("policy must be a mapping");
  }
  const data = raw as Record<string, unknown>;
  if (
    Object.keys(data).toSorted(compareCodeUnits).join(",") !==
      "branchPrefix,id,repositories,revision,vm" ||
    data.vm !== instance.name ||
    data.id !== instance.id ||
    data.branchPrefix !==
      taskPrefix(instance.id).replace(/^refs\/heads\//, "") ||
    !Number.isSafeInteger(data.revision)
  ) {
    throw new Error("policy identity, revision, or repositories are invalid");
  }
  return {
    revision: data.revision as number,
    repositories: parseGrants(data.repositories),
  };
}

async function adminCall(
  socket: string,
  route: string,
  method: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      { socketPath: socket, path: route, method, timeout: 10_000 },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode === 200) {
            resolve();
          } else {
            reject(new Error("gateway administration failed"));
          }
        });
      },
    );
    request.once("error", reject);
    request.once("timeout", () => {
      request.destroy(new Error("gateway administration timed out"));
    });
    request.end();
  });
}

function show(state: State, auth: AppAuth, name: string): void {
  const instance = active(state, name);
  const credentials: Record<string, string> = {};
  for (const repository of Object.keys(state.grants(instance.id))) {
    if (!auth.has(repository)) {
      credentials[repository] = "missing";
      continue;
    }
    const record = auth.load(repository);
    credentials[repository] =
      record.refresh_expires_at <= Math.floor(Date.now() / 1000)
        ? "expired"
        : "available";
  }
  process.stdout.write(
    YAML.stringify({
      ...(YAML.parse(policyDocument(state, instance)) as object),
      authorization: credentials,
    }),
  );
}

async function command(arguments_: string[]): Promise<void> {
  const [verb, ...args] = arguments_;
  const location = locations();
  process.umask(0o077);
  const state = new State(location.state);
  const auth = new AppAuth(location.secrets, {
    clientId: process.env.COG_GITHUB_CLIENT_ID,
    webUrl: process.env.COG_GITHUB_WEB_URL,
    apiUrl: process.env.COG_GITHUB_API_URL,
  });
  const actor = os.userInfo().username;
  try {
    switch (verb) {
      case "serve": {
        if (args.length !== 0) {
          throw new Error("usage: cog-gateway serve");
        }
        const certificates = ensureCertificates(location.secrets);
        const gateway = new Gateway(state, auth, {
          ...certificates,
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
        ensureCertificates(location.secrets);
        process.stdout.write("GitHub gateway certificates are ready\n");
        return;
      }
      case "ca-path": {
        process.stdout.write(`${ensureCertificates(location.secrets).ca}\n`);
        return;
      }
      case "health": {
        await adminCall(location.admin, "/health", "GET");
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
        if (!path.isAbsolute(limaDirectory)) {
          throw new Error("Lima instance directory must be absolute");
        }
        ensureCertificates(location.secrets);
        const socket = path.join(
          limaDirectory,
          "sock",
          `github-${randomUUID()}.sock`,
        );
        if (Buffer.byteLength(socket) > 100) {
          throw new Error("VM path is too long for a Unix socket");
        }
        const instance = state.register(name, socket, actor);
        try {
          await adminCall(location.admin, "/sync", "POST");
        } catch (error) {
          state.disable(name, actor);
          throw error;
        }
        process.stdout.write(`${JSON.stringify(instance)}\n`);
        return;
      }
      case "disable": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway disable lima:NAME");
        }
        state.disable(required(args[0], "VM name"), actor);
        await adminCall(location.admin, "/sync", "POST");
        return;
      }
      case "authorize": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway authorize OWNER/REPO");
        }
        await auth.authorize(required(args[0], "repository"));
        process.stdout.write("GitHub authorization stored on the Mac\n");
        return;
      }
      case "ensure-auth": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway ensure-auth OWNER/REPO");
        }
        const repository = normalizeRepository(required(args[0], "repository"));
        if (
          !auth.has(repository) ||
          auth.load(repository).refresh_expires_at <=
            Math.floor(Date.now() / 1000)
        ) {
          await auth.authorize(repository);
        }
        await auth.token(repository);
        return;
      }
      case "grant": {
        if (args.length !== 4 || args[2] !== "--profile") {
          throw new Error(
            "usage: cog-gateway grant lima:NAME OWNER/REPO --profile read|task",
          );
        }
        const name = required(args[0], "VM name");
        const repository = normalizeRepository(required(args[1], "repository"));
        const instance = active(state, name);
        const profileName = required(args[3], "profile");
        const profiles = parseProfiles(location.profiles);
        const grant = Object.hasOwn(profiles, profileName)
          ? profiles[profileName]
          : undefined;
        if (!grant) {
          throw new Error(`unknown profile ${profileName}`);
        }
        if (!auth.has(repository)) {
          await auth.authorize(repository);
        }
        await auth.token(repository);
        const revision = state.update(
          name,
          instance.revision,
          { ...state.grants(instance.id), [repository]: grant },
          actor,
        );
        process.stdout.write(`policy revision ${String(revision)}\n`);
        return;
      }
      case "revoke": {
        if (args.length !== 2) {
          throw new Error("usage: cog-gateway revoke lima:NAME OWNER/REPO");
        }
        const name = required(args[0], "VM name");
        const repository = normalizeRepository(required(args[1], "repository"));
        const instance = active(state, name);
        const grants = state.grants(instance.id);
        if (!Object.hasOwn(grants, repository)) {
          throw new Error(`${repository} is not granted to ${name}`);
        }
        const remaining = Object.fromEntries(
          Object.entries(grants).filter(([key]) => key !== repository),
        );
        const revision = state.update(
          name,
          instance.revision,
          remaining,
          actor,
        );
        process.stdout.write(`policy revision ${String(revision)}\n`);
        return;
      }
      case "show": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway show lima:NAME");
        }
        show(state, auth, required(args[0], "VM name"));
        return;
      }
      case "edit": {
        if (args.length !== 1) {
          throw new Error("usage: cog-gateway edit lima:NAME");
        }
        const name = required(args[0], "VM name");
        const instance = active(state, name);
        const directory = mkdtempSync(path.join(os.tmpdir(), "cog-edit-"));
        const file = path.join(directory, "policy.yaml");
        try {
          writeFileSync(file, policyDocument(state, instance), { mode: 0o600 });
          const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
          const edited = spawnSync(
            "/bin/sh",
            ["-c", `${editor} "$1"`, "cog-edit", file],
            { stdio: "inherit" },
          );
          if (edited.status !== 0) {
            throw new Error("editor failed; policy is unchanged");
          }
          const policy = parseEdit(readFileSync(file, "utf8"), instance);
          const existing = state.grants(instance.id);
          for (const repository of Object.keys(policy.repositories)) {
            if (Object.hasOwn(existing, repository)) {
              continue;
            }
            if (!auth.has(repository)) {
              await auth.authorize(repository);
            }
            await auth.token(repository);
          }
          const revision = state.update(
            name,
            policy.revision,
            policy.repositories,
            actor,
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
        const instance = state.byName(selector) ?? state.byId(selector);
        if (!instance) {
          throw new Error(`${selector} is not a known VM`);
        }
        let seen = new Set<string>();
        const limit = args[1] === "--all" ? -1 : 100;
        for (;;) {
          const logs = [
            ...state
              .logs(instance.id, limit)
              .map((entry) => ({ kind: "request", ...entry })),
            ...state
              .events(instance.id, limit)
              .map((entry) => ({ kind: "policy", ...entry })),
          ].toSorted((left, right) => left.createdAt - right.createdAt);
          for (const entry of logs) {
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
          seen = new Set(logs.map((entry) => entry.id));
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
    state.close();
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
