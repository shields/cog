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

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { compareCodeUnits } from "./policy.ts";

export interface Account {
  name: string;
  token: string;
}

export type PoolLoad =
  { usable: true; accounts: Account[] } | { usable: false; reason: string };

export interface AccountSnapshot {
  name: string;
  held: boolean;
  heldUntil: number | null;
  buckets: { bucket: string; utilization: number; expires: number }[];
}

export const unconfiguredReason = "the Claude pool is not configured";

export const accountName = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const tokenPrefix = "sk-ant-oat";
const tokenLimit = 4096;
const visibleAscii = /^[!-~]+$/u;
const groupOrOther = 0o077;

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function failure(about: string, error: unknown): string {
  const code = errorCode(error);
  return `${about} cannot be read${code === null ? "" : ` (${code})`}`;
}

export function checkToken(token: string): string | null {
  if (token.length === 0 || token.length > tokenLimit) {
    return "must hold one token of at most 4096 characters";
  }
  if (!visibleAscii.test(token)) {
    return "must hold one token of visible ASCII characters";
  }
  if (!token.startsWith(tokenPrefix)) {
    return `must hold a token that starts with ${tokenPrefix}`;
  }
  return null;
}

// A reason never carries file content, and names an entry only when its name
// is one that an account may have.
function loadAccount(
  directory: string,
  name: string,
): Account | { reason: string } {
  if (!accountName.test(name)) {
    return { reason: "an entry has a name that is not allowed" };
  }
  const about = `account ${name}`;
  const file = path.join(directory, name);
  let text: string;
  try {
    const status = lstatSync(file);
    if (!status.isFile()) {
      return { reason: `${about} is not a regular file` };
    }
    if ((status.mode & groupOrOther) !== 0) {
      return { reason: `${about} is accessible to group or other` };
    }
    if (status.size > tokenLimit + 1) {
      return { reason: `${about} is larger than a token` };
    }
    text = readFileSync(file, "latin1");
  } catch (error) {
    return { reason: failure(about, error) };
  }
  const token = text.endsWith("\n") ? text.slice(0, -1) : text;
  const violation = checkToken(token);
  return violation === null
    ? { name, token }
    : { reason: `${about} ${violation}` };
}

export function directoryProblem(
  status: Pick<Stats, "isDirectory" | "mode">,
): string | null {
  if (!status.isDirectory()) {
    return "the Claude pool location is not a real directory";
  }
  if ((status.mode & groupOrOther) !== 0) {
    return "the Claude pool directory is accessible to group or other";
  }
  return null;
}

export function loadPool(directory: string): PoolLoad {
  const unusable = (reason: string): PoolLoad => ({ usable: false, reason });
  let names: string[];
  try {
    const status = lstatSync(directory);
    const problem = directoryProblem(status);
    if (problem !== null) {
      return unusable(problem);
    }
    names = readdirSync(directory);
  } catch (error) {
    return unusable(
      errorCode(error) === "ENOENT"
        ? unconfiguredReason
        : failure("the Claude pool directory", error),
    );
  }
  const accounts: Account[] = [];
  for (const name of names.toSorted(compareCodeUnits)) {
    if (name.startsWith(".")) {
      continue;
    }
    const loaded = loadAccount(directory, name);
    if ("reason" in loaded) {
      return unusable(loaded.reason);
    }
    accounts.push(loaded);
  }
  return accounts.length === 0
    ? unusable(unconfiguredReason)
    : { usable: true, accounts };
}

const nearLimit = 0.9;
const hour = 3_600_000;
const eightDays = 8 * 86_400_000;
const unifiedBucket = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/u;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const epochSeconds = /^[0-9]{1,15}$/u;

interface Bucket {
  utilization: number;
  expires: number;
}

interface Runtime {
  heldAt: number;
  heldUntil: number;
  buckets: Map<string, Bucket>;
}

function headerValue(
  headers: readonly string[],
  name: string,
): string | undefined {
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === name) {
      return headers[index + 1];
    }
  }
  return undefined;
}

function resetTime(value: string | undefined, now: number): number | null {
  if (value === undefined || !epochSeconds.test(value)) {
    return null;
  }
  const at = Number(value) * 1000;
  return at > now && at - now <= eightDays ? at : null;
}

export class AccountPool {
  private readonly accounts: Account[];
  private readonly runtime = new Map<string, Runtime>();

  constructor(accounts: readonly Account[], previous: AccountPool | null) {
    this.accounts = accounts.map(({ name, token }) => ({ name, token }));
    for (const { name, token } of this.accounts) {
      const kept = previous?.accounts.some(
        (account) => account.name === name && account.token === token,
      )
        ? previous.runtime.get(name)
        : undefined;
      this.runtime.set(
        name,
        kept ?? { heldAt: 0, heldUntil: 0, buckets: new Map() },
      );
    }
  }

  private state(name: string): Runtime {
    const state = this.runtime.get(name);
    if (state === undefined) {
      throw new Error("unknown account");
    }
    return state;
  }

  private held(name: string, now: number): boolean {
    return this.state(name).heldUntil > now;
  }

  private near(name: string, now: number): boolean {
    return this.state(name)
      .buckets.values()
      .some(
        (bucket) => bucket.expires > now && bucket.utilization >= nearLimit,
      );
  }

  choose(instanceId: string, now: number): Account {
    const order = this.accounts
      .map((account) => ({
        account,
        rank: createHash("sha256")
          .update(`${instanceId}\0${account.name}`)
          .digest("hex"),
      }))
      .toSorted((a, b) => compareCodeUnits(a.rank, b.rank))
      .map(({ account }) => account);
    const chosen =
      order.find(
        ({ name }) => !this.held(name, now) && !this.near(name, now),
      ) ??
      order.find(({ name }) => !this.held(name, now)) ??
      order[0];
    if (chosen === undefined) {
      throw new Error("the pool has no account");
    }
    return chosen;
  }

  observe(
    name: string,
    status: number,
    headers: readonly string[],
    now: number,
    startedAt = now,
  ): void {
    const state = this.runtime.get(name);
    if (state === undefined || status === 403) {
      return;
    }
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const bucket = unifiedBucket.exec(
        headers[index]?.toLowerCase() ?? "",
      )?.[1];
      const value = headers[index + 1] ?? "";
      if (bucket === undefined || !decimal.test(value.trim())) {
        continue;
      }
      const utilization = Number(value);
      if (Number.isFinite(utilization)) {
        state.buckets.set(bucket, {
          utilization,
          expires:
            resetTime(
              headerValue(
                headers,
                `anthropic-ratelimit-unified-${bucket}-reset`,
              ),
              now,
            ) ?? now + hour,
        });
      }
    }
    if (status >= 200 && status < 300) {
      // A request that was sent before the hold began says nothing about it.
      if (startedAt >= state.heldAt) {
        state.heldUntil = 0;
      }
    } else if (
      status === 429 &&
      headerValue(headers, "anthropic-ratelimit-unified-status") === "rejected"
    ) {
      state.heldAt = now;
      state.heldUntil =
        resetTime(
          headerValue(headers, "anthropic-ratelimit-unified-reset"),
          now,
        ) ?? Math.max(state.heldUntil, now + 300_000);
    } else if (status === 401) {
      // The request's path and headers are the guest's, so a 401 may not cut
      // a longer hold short or write a line for each one of a run.
      if (state.heldUntil <= now) {
        process.stderr.write(
          `cog: the provider refused Claude pool account ${name} (401)\n`,
        );
      }
      state.heldAt = now;
      state.heldUntil = Math.max(state.heldUntil, now + 600_000);
    }
  }

  snapshot(now: number): AccountSnapshot[] {
    return this.accounts.map(({ name }) => {
      const state = this.state(name);
      return {
        name,
        held: state.heldUntil > now,
        heldUntil: state.heldUntil > now ? state.heldUntil : null,
        buckets: [...state.buckets]
          .filter(([, bucket]) => bucket.expires > now)
          .map(([bucket, { utilization, expires }]) => ({
            bucket,
            utilization,
            expires,
          })),
      };
    });
  }
}
