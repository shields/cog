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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { AppAuth, defaultApiUrl, type DeviceCodePrompt } from "./auth.ts";
import { ensureCertificates, type Certificates } from "./cert.ts";
import {
  compareCodeUnits,
  cogPrefix,
  normalizeRepository,
  parseGrants,
  type Access,
  type Grant,
} from "./policy.ts";
import {
  State,
  type AccessLog,
  type Instance,
  type PolicyEvent,
  type TailscaleNode,
} from "./state.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Locations {
  state: string;
  secrets: string;
  admin: string;
  pool: string;
}

// HOME comes from the environment, not from the passwd entry.
export function locations(env: Env): Locations {
  const root = env.COG_ROOT;
  if (root) {
    return {
      state: path.join(root, "state"),
      secrets: path.join(root, "secrets"),
      admin: path.join(root, "state", "admin.sock"),
      pool: path.join(root, "secrets", "claude-pool"),
    };
  }
  const home = env.HOME;
  if (!home) {
    throw new Error("HOME is not set");
  }
  const state = path.join(home, ".local", "state", "cog");
  const secrets = path.join(home, ".config", "secrets", "cog");
  return {
    state,
    secrets,
    admin: path.join(state, "admin.sock"),
    pool: path.join(secrets, "claude-pool"),
  };
}

export interface ControlOptions {
  clientId?: string | undefined;
  webUrl?: string | undefined;
  apiUrl?: string | undefined;
  baseName?: string | undefined;
  actor?: string | undefined;
}

export function controlOptions(env: Env): ControlOptions {
  return {
    clientId: env.COG_GITHUB_CLIENT_ID,
    webUrl: env.COG_GITHUB_WEB_URL,
    apiUrl: env.COG_GITHUB_API_URL,
    baseName: env.COG_BASE === "" ? undefined : env.COG_BASE,
  };
}

export function required(
  value: string | undefined,
  description: string,
): string {
  if (!value) {
    throw new Error(`missing ${description}`);
  }
  return value;
}

function branchPrefix(instance: Instance): string {
  return cogPrefix(instance.id).replace(/^refs\/heads\//, "");
}

export function policyDocument(state: State, instance: Instance): string {
  return YAML.stringify({
    vm: instance.name,
    id: instance.id,
    revision: instance.revision,
    branchPrefix: branchPrefix(instance),
    repositories: state.grants(instance.id),
  });
}

export function parseEdit(
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
    data.branchPrefix !== branchPrefix(instance) ||
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

export type LogRow =
  (AccessLog & { kind: "request" }) | (PolicyEvent & { kind: "policy" });

export class Control {
  readonly location: Locations;
  readonly actor: string;
  readonly #options: ControlOptions;
  #state: State | undefined;
  #auth: AppAuth | undefined;

  constructor(location: Locations, options: ControlOptions = {}) {
    this.location = location;
    this.#options = options;
    this.actor = options.actor ?? os.userInfo().username;
  }

  // Opened on first use, so that a command that needs neither creates no
  // directory.
  get state(): State {
    this.#state ??= new State(this.location.state, {
      baseName: this.#options.baseName,
    });
    return this.#state;
  }

  get auth(): AppAuth {
    this.#auth ??= new AppAuth(this.location.secrets, {
      clientId: this.#options.clientId,
      webUrl: this.#options.webUrl,
      apiUrl: this.#options.apiUrl,
    });
    return this.#auth;
  }

  close(): void {
    this.#state?.close();
    this.#state = undefined;
  }

  certificates(): Certificates {
    return ensureCertificates(this.location.secrets);
  }

  async health(): Promise<void> {
    await adminCall(this.location.admin, "/health", "GET");
  }

  async sync(): Promise<void> {
    await adminCall(this.location.admin, "/sync", "POST");
  }

  active(name: string): Instance {
    const instance = this.state.byName(name);
    if (!instance || instance.disabled) {
      throw new Error(`${name} is not a registered VM`);
    }
    return instance;
  }

  // The daemon must listen on the VM's socket before the VM starts, so the
  // registration is undone when the daemon cannot be told.
  async register(name: string, limaDirectory: string): Promise<Instance> {
    if (!path.isAbsolute(limaDirectory)) {
      throw new Error("Lima instance directory must be absolute");
    }
    ensureCertificates(this.location.secrets);
    const socket = path.join(
      limaDirectory,
      "sock",
      `github-${randomUUID()}.sock`,
    );
    if (Buffer.byteLength(socket) > 100) {
      throw new Error("VM path is too long for a Unix socket");
    }
    const instance = this.state.register(name, socket, this.actor);
    try {
      await this.sync();
    } catch (error) {
      this.state.disable(name, this.actor);
      throw error;
    }
    return instance;
  }

  async disable(
    name: string,
    options: { forRemoval?: boolean } = {},
  ): Promise<TailscaleNode | null> {
    const node = this.state.disable(name, this.actor, options);
    await this.sync();
    return node;
  }

  async authorize(repository: string): Promise<void> {
    await this.auth.authorize(repository);
  }

  async prepareRepository(repository: string): Promise<Access> {
    const normalized = normalizeRepository(repository);
    const apiUrl = this.#options.apiUrl ?? defaultApiUrl;
    const response = await fetch(`${apiUrl}/repos/${normalized}`, {
      method: "HEAD",
      headers: { "User-Agent": "cog" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 200) return "anonymous";
    if (response.status !== 404) {
      throw new Error(
        `cannot check anonymous access to ${normalized} (HTTP ${String(response.status)})`,
      );
    }
    if (
      !this.auth.has(normalized) ||
      this.auth.load(normalized).refresh_expires_at <=
        Math.floor(Date.now() / 1000)
    ) {
      await this.auth.authorize(normalized);
    }
    await this.auth.token(normalized);
    return "authenticated";
  }

  async grant(
    name: string,
    repositoryName: string,
    grant: Grant,
    prompt?: DeviceCodePrompt,
  ): Promise<number> {
    const repository = normalizeRepository(repositoryName);
    const instance = this.active(name);
    if (!this.auth.has(repository)) {
      await this.auth.authorize(repository, prompt);
    }
    await this.auth.token(repository);
    return this.state.update(
      name,
      instance.revision,
      { ...this.state.grants(instance.id), [repository]: grant },
      this.actor,
    );
  }

  revoke(name: string, repositoryName: string): number {
    const repository = normalizeRepository(repositoryName);
    const instance = this.active(name);
    const grants = this.state.grants(instance.id);
    if (!Object.hasOwn(grants, repository)) {
      throw new Error(`${repository} is not granted to ${name}`);
    }
    const remaining = Object.fromEntries(
      Object.entries(grants).filter(([key]) => key !== repository),
    );
    return this.state.update(name, instance.revision, remaining, this.actor);
  }

  show(name: string): string {
    const instance = this.active(name);
    const credentials: Record<string, string> = {};
    for (const repository of Object.keys(this.state.grants(instance.id))) {
      if (!this.auth.has(repository)) {
        credentials[repository] = "missing";
        continue;
      }
      const record = this.auth.load(repository);
      credentials[repository] =
        record.refresh_expires_at <= Math.floor(Date.now() / 1000)
          ? "expired"
          : "available";
    }
    return YAML.stringify({
      ...(YAML.parse(policyDocument(this.state, instance)) as object),
      authorization: credentials,
    });
  }

  // The document for a person to edit, and the VM it describes.
  beginEdit(name: string): { instance: Instance; document: string } {
    const instance = this.active(name);
    return { instance, document: policyDocument(this.state, instance) };
  }

  async commitEdit(
    name: string,
    instance: Instance,
    content: string,
  ): Promise<number> {
    const policy = parseEdit(content, instance);
    const existing = this.state.grants(instance.id);
    for (const repository of Object.keys(policy.repositories)) {
      if (Object.hasOwn(existing, repository)) {
        continue;
      }
      if (!this.auth.has(repository)) {
        await this.auth.authorize(repository);
      }
      await this.auth.token(repository);
    }
    return this.state.update(
      name,
      policy.revision,
      policy.repositories,
      this.actor,
    );
  }

  // The VM by name, or else by ID, which still finds it after it is disabled.
  findInstance(selector: string): Instance {
    const instance = this.state.byName(selector) ?? this.state.byId(selector);
    if (!instance) {
      throw new Error(`${selector} is not a known VM`);
    }
    return instance;
  }

  // The requests and policy changes of a VM, the oldest first.
  logs(instance: Instance, limit: number): LogRow[] {
    return [
      ...this.state
        .logs(instance.id, limit)
        .map((entry) => ({ kind: "request" as const, ...entry })),
      ...this.state
        .events(instance.id, limit)
        .map((entry) => ({ kind: "policy" as const, ...entry })),
    ].toSorted((left, right) => left.createdAt - right.createdAt);
  }
}
