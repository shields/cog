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

import { spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeRepository } from "./policy.ts";

export interface AuthRecord {
  client_id: string;
  repository: string;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
  refresh_expires_at: number;
  web_url: string;
  api_url: string;
}

interface TokenReply {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

const tokenPattern = /^[A-Za-z0-9_.~+/=-]+$/;
const clientIdPattern = /^[A-Za-z0-9._-]+$/;

function tokenReply(payload: unknown): TokenReply {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub returned an invalid token response");
  }
  const reply = payload as Record<string, unknown>;
  if (
    typeof reply.access_token !== "string" ||
    !tokenPattern.test(reply.access_token) ||
    typeof reply.refresh_token !== "string" ||
    !tokenPattern.test(reply.refresh_token) ||
    !Number.isSafeInteger(reply.expires_in) ||
    Number(reply.expires_in) <= 0 ||
    !Number.isSafeInteger(reply.refresh_token_expires_in) ||
    Number(reply.refresh_token_expires_in) <= 0
  ) {
    throw new Error("GitHub returned an incomplete token response");
  }
  return reply as unknown as TokenReply;
}

function recordFrom(payload: unknown, repository: string): AuthRecord {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid authorization record for ${repository}`);
  }
  const record = payload as Record<string, unknown>;
  if (
    record.repository !== repository ||
    typeof record.client_id !== "string" ||
    !clientIdPattern.test(record.client_id) ||
    typeof record.access_token !== "string" ||
    !tokenPattern.test(record.access_token) ||
    typeof record.refresh_token !== "string" ||
    !tokenPattern.test(record.refresh_token) ||
    !Number.isSafeInteger(record.access_expires_at) ||
    !Number.isSafeInteger(record.refresh_expires_at) ||
    typeof record.web_url !== "string" ||
    typeof record.api_url !== "string"
  ) {
    throw new Error(`invalid authorization record for ${repository}`);
  }
  const web = new URL(record.web_url);
  const api = new URL(record.api_url);
  if (
    web.username ||
    web.password ||
    web.search ||
    web.hash ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  ) {
    throw new Error(`invalid authorization endpoints for ${repository}`);
  }
  return record as unknown as AuthRecord;
}

type AuthRequest = (
  url: string,
  init: BunFetchRequestInit,
) => Promise<Response>;

async function postForm(
  url: string,
  form: Record<string, string>,
  request: AuthRequest = fetch,
): Promise<Record<string, unknown>> {
  const response = await request(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "cog",
    },
    body: new URLSearchParams(form),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("GitHub authorization endpoint redirected");
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new Error("GitHub returned invalid JSON to an authorization request");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub returned an invalid authorization response");
  }
  return payload as Record<string, unknown>;
}

export class AppAuth {
  readonly directory: string;
  readonly clientId: string;
  readonly webUrl: string;
  readonly apiUrl: string;

  constructor(
    directory: string,
    options: {
      clientId?: string | undefined;
      webUrl?: string | undefined;
      apiUrl?: string | undefined;
    } = {},
  ) {
    this.directory = directory;
    this.clientId = options.clientId ?? "Iv23lim5x4MdkNNgv28z";
    this.webUrl = options.webUrl ?? "https://github.com";
    this.apiUrl = options.apiUrl ?? "https://api.github.com";
    if (!clientIdPattern.test(this.clientId)) {
      throw new Error("invalid GitHub App client ID");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  private file(repository: string): string {
    return path.join(
      this.directory,
      `${Buffer.from(normalizeRepository(repository)).toString("base64url")}.json`,
    );
  }

  has(repository: string): boolean {
    return existsSync(this.file(repository));
  }

  load(repository: string): AuthRecord {
    const key = normalizeRepository(repository);
    const file = this.file(key);
    if (!existsSync(file)) {
      throw new Error(
        `GitHub authorization for ${key} is missing; run cog authorize ${key}`,
      );
    }
    const contents = readFileSync(file, "utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(contents);
    } catch {
      // A JSON syntax error can quote the file, which holds the tokens, so it
      // is not attached as the cause.
      throw new Error(`invalid authorization record for ${key}`);
    }
    return recordFrom(payload, key);
  }

  private save(record: AuthRecord): void {
    const file = this.file(record.repository);
    const temporary = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fsyncSync(descriptor);
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    } finally {
      closeSync(descriptor);
    }
    const directoryDescriptor = openSync(this.directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  private async locked<T>(
    repository: string,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const lock = `${this.file(repository)}.lock`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `GitHub authorization for ${repository} is locked; inspect ${lock}`,
            { cause: error },
          );
        }
        await delay(100);
      }
    }
    try {
      return await work();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  async token(repository: string): Promise<string> {
    const key = normalizeRepository(repository);
    const record = this.load(key);
    if (record.access_expires_at - Math.floor(Date.now() / 1000) >= 600) {
      return record.access_token;
    }
    return this.locked(key, async () => {
      const current = this.load(key);
      const now = Math.floor(Date.now() / 1000);
      if (current.access_expires_at - now >= 600) {
        return current.access_token;
      }
      if (current.refresh_expires_at <= now) {
        throw new Error(
          `GitHub authorization for ${key} expired; run cog authorize ${key}`,
        );
      }
      const reply = await postForm(
        `${current.web_url}/login/oauth/access_token`,
        {
          client_id: current.client_id,
          grant_type: "refresh_token",
          refresh_token: current.refresh_token,
        },
      );
      if (reply.error !== undefined) {
        throw new Error(
          `GitHub refused refresh for ${key}; run cog authorize ${key}`,
        );
      }
      const renewed = tokenReply(reply);
      this.save({
        ...current,
        access_token: renewed.access_token,
        access_expires_at: now + renewed.expires_in,
        refresh_token: renewed.refresh_token,
        refresh_expires_at: now + renewed.refresh_token_expires_in,
      });
      return renewed.access_token;
    });
  }

  async issue(
    repository: string,
    {
      hostname,
      request = fetch,
    }: { hostname?: string; request?: AuthRequest } = {},
  ): Promise<AuthRecord> {
    const key = normalizeRepository(repository);
    const args = ["api", `repos/${key}`, "--jq", ".id"];
    if (hostname !== undefined) {
      args.push("--hostname", hostname);
    }
    const gh = spawnSync("gh", args, {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (gh.error) {
      throw new Error(`cannot run gh to read ${key}: ${gh.error.message}`, {
        cause: gh.error,
      });
    }
    const repositoryId = gh.stdout.trim();
    if (gh.status !== 0 || !/^[1-9][0-9]*$/.test(repositoryId)) {
      throw new Error(
        `gh cannot read ${key}; check the repository and your Mac gh login`,
      );
    }
    const device = await postForm(
      `${this.webUrl}/login/device/code`,
      { client_id: this.clientId },
      request,
    );
    const deviceCode = device.device_code;
    const userCode = device.user_code;
    const verificationUri = device.verification_uri;
    let interval = device.interval;
    const expiresIn = device.expires_in;
    if (
      typeof deviceCode !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(deviceCode) ||
      typeof userCode !== "string" ||
      userCode.length > 32 ||
      typeof verificationUri !== "string" ||
      !verificationUri.startsWith("https://") ||
      !Number.isSafeInteger(interval) ||
      Number(interval) < 0 ||
      !Number.isSafeInteger(expiresIn) ||
      Number(expiresIn) <= 0
    ) {
      throw new Error(
        "GitHub returned an invalid device authorization response",
      );
    }
    process.stderr.write(
      `Open ${verificationUri} and enter code ${userCode} to authorize ${key}\n`,
    );
    const deadline = Date.now() + Number(expiresIn) * 1000;
    while (Date.now() < deadline) {
      await delay(Number(interval) * 1000);
      const now = Math.floor(Date.now() / 1000);
      const reply = await postForm(
        `${this.webUrl}/login/oauth/access_token`,
        {
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          repository_id: repositoryId,
        },
        request,
      );
      if (reply.error === "authorization_pending") {
        continue;
      }
      if (reply.error === "slow_down") {
        interval =
          Number.isSafeInteger(reply.interval) && Number(reply.interval) >= 0
            ? reply.interval
            : Number(interval) + 5;
        continue;
      }
      if (reply.error !== undefined) {
        throw new Error(`GitHub device authorization for ${key} failed`);
      }
      const tokens = tokenReply(reply);
      const verification = await request(`${this.apiUrl}/repos/${key}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": "cog",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (verification.status !== 200) {
        throw new Error(`GitHub App token cannot read ${key}`);
      }
      const identity = (await verification.json()) as unknown;
      if (
        !identity ||
        typeof identity !== "object" ||
        Array.isArray(identity)
      ) {
        throw new Error(
          `GitHub App token returned the wrong repository for ${key}`,
        );
      }
      const verified = identity as Record<string, unknown>;
      if (
        verified.id !== Number(repositoryId) ||
        typeof verified.full_name !== "string" ||
        normalizeRepository(verified.full_name) !== key
      ) {
        throw new Error(
          `GitHub App token returned the wrong repository for ${key}`,
        );
      }
      return {
        client_id: this.clientId,
        repository: key,
        access_token: tokens.access_token,
        access_expires_at: now + tokens.expires_in,
        refresh_token: tokens.refresh_token,
        refresh_expires_at: now + tokens.refresh_token_expires_in,
        web_url: this.webUrl,
        api_url: this.apiUrl,
      };
    }
    throw new Error(`GitHub device code for ${key} expired`);
  }

  async authorize(repository: string): Promise<void> {
    const record = await this.issue(repository);
    await this.locked(record.repository, () => {
      this.save(record);
    });
  }
}
