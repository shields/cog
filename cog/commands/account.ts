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

import {
  type BigIntStats,
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Control, PoolStatus } from "../../gateway/control.ts";
import {
  accountName,
  checkToken,
  directoryProblem,
  loadPool,
  unconfiguredReason,
  type AccountSnapshot,
} from "../../gateway/pool.ts";
import { CogError, Interrupted } from "../errors.ts";
import { say, writeAll } from "../output.ts";
import { toBytes } from "../secrets.ts";
import type { Context } from "./context.ts";

export type AccountContext = Pick<Context, "config" | "prompt"> & {
  readonly gateway: () => Pick<Control, "location" | "sync" | "pool">;
};

export interface AccountIo {
  readonly say: (text: string) => void;
  readonly link: (existing: string, created: string) => void;
  readonly close: (descriptor: number) => void;
}

const realIo: AccountIo = { say, link: linkSync, close: closeSync };

const usage =
  "usage: cog account add claude NAME | rm claude NAME | rename claude OLD NEW | list | status";

const provider = "claude";

function withProvider(args: string[]): string[] {
  const [word, ...rest] = args;
  if (word === undefined) {
    throw new CogError(usage);
  }
  if (word !== provider) {
    // A word that no account name can be may be a token typed where the
    // provider goes, so it is not echoed.
    throw new CogError(
      accountName.test(word)
        ? `unknown provider ${JSON.stringify(word)}; ${provider} is the only provider`
        : `unknown provider; ${provider} is the only provider`,
    );
  }
  return rest;
}

function code(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown error";
}

function validAccount(name: string | undefined, rest: string[]): string {
  if (name === undefined || rest.length > 0) {
    throw new CogError(usage);
  }
  if (!accountName.test(name)) {
    throw new CogError(
      `the account name must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter or digit (${accountName.source})`,
    );
  }
  return name;
}

// A stray entry that the loader refuses has a name that no account may have, so
// removal takes any plain file name in the pool directory.
function existingEntry(name: string | undefined, rest: string[]): string {
  if (name === undefined || rest.length > 0) {
    throw new CogError(usage);
  }
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name
  ) {
    throw new CogError(
      "NAME must be an account name or the plain file name of an entry in the pool directory",
    );
  }
  return name;
}

function lstatOrNull(file: string, bigint: true): BigIntStats | null;
function lstatOrNull(file: string): Stats | null;
function lstatOrNull(file: string, bigint = false): Stats | BigIntStats | null {
  try {
    return lstatSync(file, { bigint });
  } catch (error) {
    if (code(error) === "ENOENT") {
      return null;
    }
    throw new CogError(`cannot inspect ${file} (${code(error)})`);
  }
}

function exists(name: string): CogError {
  return new CogError(
    `account ${name} already exists; run cog account rm ${provider} ${name} first`,
  );
}

function taken(name: string): CogError {
  return new CogError(
    `account ${name} already exists; choose another name, or run cog account rm ${provider} ${name} first`,
  );
}

function notRegular(name: string, entry: string): CogError {
  return new CogError(
    `account ${name} is not a regular file; remove ${entry} by hand`,
  );
}

function directoryIsMissing(directory: string): boolean {
  const status = lstatOrNull(directory);
  if (status === null) {
    return true;
  }
  const problem = directoryProblem(status);
  if (problem !== null) {
    throw new CogError(`${problem}; nothing was changed`);
  }
  return false;
}

function createDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch (error) {
    throw new CogError(
      `cannot create ${directory} (${code(error)}); nothing was changed`,
    );
  }
}

function attempt(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // The write failed first, and its error is the one that is reported.
  }
}

const heldSignals = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

// The work is synchronous, so a signal handler cannot run inside it; the
// handlers keep the default action from killing the process between its first
// and its last step (a temporary's creation and its unlink, or a rename's link
// and its unlink), and the signal takes effect afterwards. A signal that
// arrives during the work is dispatched on a later turn of the event loop, so
// the handlers stay until one has passed.
async function holdingSignals(work: () => void): Promise<void> {
  const received: { status: number | null } = { status: null };
  const handlers = new Map<string, () => void>();
  for (const [name, status] of Object.entries(heldSignals)) {
    const handler = (): void => {
      received.status ??= status;
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }
  let failure: { error: unknown } | undefined;
  try {
    try {
      work();
    } catch (error) {
      failure = { error };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } finally {
    for (const [name, handler] of handlers) {
      process.off(name, handler);
    }
  }
  if (received.status !== null) {
    throw new Interrupted(received.status);
  }
  if (failure !== undefined) {
    throw failure.error;
  }
}

const strayTemporary = /^\.[a-z0-9-]+\.[0-9a-f]{12}$/;
const strayAgeMs = 60_000;

// A SIGKILL or a power loss can leave a temporary that holds a token. One
// younger than a minute may belong to an add in progress. The entry that rm was
// asked for is left to rm, which reports its removal.
function removeStrayTemporaries(directory: string, keep = ""): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (code(error) === "ENOENT") {
      return;
    }
    throw new CogError(`cannot read ${directory} (${code(error)})`);
  }
  const now = Date.now();
  for (const name of names) {
    if (name === keep || !strayTemporary.test(name)) {
      continue;
    }
    const file = path.join(directory, name);
    const status = lstatOrNull(file);
    if (
      status === null ||
      !status.isFile() ||
      now - status.mtimeMs < strayAgeMs
    ) {
      continue;
    }
    try {
      unlinkSync(file);
    } catch (error) {
      if (code(error) !== "ENOENT") {
        throw new CogError(
          `cannot remove the stray temporary file ${file} (${code(error)})`,
        );
      }
    }
  }
}

// The entry appears complete and with mode 600, or not at all. The temporary
// name starts with a dot, which the loader skips, so a crash cannot leave an
// entry that disables the pool. The link fails rather than replace an entry.
async function writeAccount(
  io: AccountIo,
  directory: string,
  name: string,
  token: string,
): Promise<void> {
  await holdingSignals(() => {
    writeEntry(io, directory, name, token);
  });
}

function writeEntry(
  io: AccountIo,
  directory: string,
  name: string,
  token: string,
): void {
  const entry = path.join(directory, name);
  const temporary = path.join(
    directory,
    `.${name}.${randomBytes(6).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeAll(descriptor, toBytes(`${token}\n`));
    fsyncSync(descriptor);
    const written = descriptor;
    descriptor = undefined;
    io.close(written);
    io.link(temporary, entry);
  } catch (error) {
    const unclosed = descriptor;
    if (unclosed !== undefined) {
      attempt(() => {
        io.close(unclosed);
      });
    }
    attempt(() => {
      unlinkSync(temporary);
    });
    if (code(error) === "EEXIST") {
      throw exists(name);
    }
    throw new CogError(`cannot write account ${name} (${code(error)})`);
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (code(error) !== "ENOENT") {
      throw new CogError(
        `the token for ${name} is saved in ${directory}, but its temporary file ${temporary} cannot be removed (${code(error)}); remove it by hand`,
      );
    }
  }
}

async function reload(
  context: AccountContext,
  saved: string,
  options: { mayBeEmpty: boolean },
): Promise<PoolStatus> {
  const gateway = context.gateway();
  let status: PoolStatus;
  try {
    await gateway.sync();
    status = await gateway.pool();
  } catch (error) {
    throw new CogError(
      `${saved}, but the gateway could not reload it: ${error instanceof Error ? error.message : "unknown error"}; check it with cog account status`,
    );
  }
  if (
    status.state !== "usable" &&
    !(options.mayBeEmpty && status.state === "unconfigured")
  ) {
    throw new CogError(
      `${saved}, but the Claude pool is not usable: ${status.reason ?? unconfiguredReason}`,
    );
  }
  return status;
}

async function add(
  args: string[],
  context: AccountContext,
  io: AccountIo,
): Promise<void> {
  const [first, ...rest] = withProvider(args);
  const name = validAccount(first, rest);
  const directory = context.gateway().location.pool;
  const missing = directoryIsMissing(directory);
  if (!missing) {
    removeStrayTemporaries(directory);
  }
  const entry = path.join(directory, name);
  const present = lstatOrNull(entry);
  if (present !== null) {
    throw present.isFile() ? exists(name) : notRegular(name, entry);
  }
  const token = await context.prompt(context.config.promptInput);
  const violation = checkToken(token);
  if (violation !== null) {
    throw new CogError(`the Claude token ${violation}; nothing was changed`);
  }
  if (missing) {
    createDirectory(directory);
  }
  try {
    await writeAccount(io, directory, name, token);
  } catch (error) {
    if (missing) {
      try {
        rmdirSync(directory);
      } catch {
        // The directory is not empty or is already gone.
      }
    }
    throw error;
  }
  const saved = `the token for ${name} is saved in ${directory}`;
  const status = await reload(context, saved, { mayBeEmpty: false });
  io.say(
    `cog: ${saved}; the pool has ${String(status.accounts.length)} account(s)`,
  );
}

async function remove(
  args: string[],
  context: AccountContext,
  io: AccountIo,
): Promise<void> {
  const [first, ...rest] = withProvider(args);
  const name = existingEntry(first, rest);
  const directory = context.gateway().location.pool;
  const entry = path.join(directory, name);
  if (directoryIsMissing(directory)) {
    throw new CogError(`there is no account ${name}`);
  }
  removeStrayTemporaries(directory, name);
  const status = lstatOrNull(entry);
  if (status === null) {
    throw new CogError(`there is no account ${name}`);
  }
  if (!status.isFile()) {
    throw notRegular(name, entry);
  }
  try {
    unlinkSync(entry);
  } catch (error) {
    throw new CogError(`cannot remove account ${name} (${code(error)})`);
  }
  const saved = `account ${name} is removed from ${directory}`;
  const after = await reload(context, saved, { mayBeEmpty: true });
  io.say(
    `cog: ${saved}; the pool has ${String(after.accounts.length)} account(s)`,
  );
}

async function rename(
  args: string[],
  context: AccountContext,
  io: AccountIo,
): Promise<void> {
  const [from, to, ...rest] = withProvider(args);
  if (from === undefined || to === undefined || rest.length > 0) {
    throw new CogError(usage);
  }
  const oldName = validAccount(from, []);
  const newName = validAccount(to, []);
  if (oldName === newName) {
    throw new CogError("the old and the new name are the same");
  }
  const directory = context.gateway().location.pool;
  if (directoryIsMissing(directory)) {
    throw new CogError(`there is no account ${oldName}`);
  }
  removeStrayTemporaries(directory);
  const oldEntry = path.join(directory, oldName);
  const newEntry = path.join(directory, newName);
  const source = lstatOrNull(oldEntry, true);
  if (source === null) {
    throw new CogError(`there is no account ${oldName}`);
  }
  if (!source.isFile()) {
    throw notRegular(oldName, oldEntry);
  }
  const target = lstatOrNull(newEntry, true);
  if (target !== null) {
    if (!target.isFile()) {
      throw notRegular(newName, newEntry);
    }
    if (target.dev === source.dev && target.ino === source.ino) {
      throw new CogError(
        `accounts ${oldName} and ${newName} are one file, left by a rename that did not finish; run cog account rm ${provider} ${oldName} to finish it`,
      );
    }
    throw taken(newName);
  }
  await holdingSignals(() => {
    renameEntry(io, directory, oldName, newName);
  });
  const saved = `account ${oldName} is renamed to ${newName} in ${directory}`;
  const after = await reload(context, saved, { mayBeEmpty: false });
  io.say(
    `cog: ${saved}; the pool has ${String(after.accounts.length)} account(s)`,
  );
}

// The link fails rather than replace an entry that a concurrent add has just
// made, and the token file is never opened. A failed unlink leaves both names
// on one file, which the loader accepts as two accounts, and is not undone: the
// entry that the unlink could not remove is the one that the user is told to
// remove. An unlink that finds OLD gone means that another command changed it
// between the two steps, and says so.
function renameEntry(
  io: AccountIo,
  directory: string,
  oldName: string,
  newName: string,
): void {
  const oldEntry = path.join(directory, oldName);
  const newEntry = path.join(directory, newName);
  try {
    io.link(oldEntry, newEntry);
  } catch (error) {
    if (code(error) === "EEXIST") {
      throw taken(newName);
    }
    if (code(error) === "ENOENT") {
      throw new CogError(`there is no account ${oldName}`);
    }
    throw new CogError(
      `cannot rename account ${oldName} (${code(error)}); nothing was changed`,
    );
  }
  try {
    unlinkSync(oldEntry);
  } catch (error) {
    if (code(error) === "ENOENT") {
      throw new CogError(
        `account ${oldName} was removed by another command while it was renamed to ${newName}; ${newName} holds its token, so check cog account list`,
      );
    }
    throw new CogError(
      `account ${oldName} is also named ${newName} now, since ${oldName} cannot be removed (${code(error)}); both names hold the token, so run cog account rm ${provider} ${oldName} when it can be removed`,
    );
  }
}

function list(args: string[], context: AccountContext, io: AccountIo): void {
  if (args.length > 0) {
    throw new CogError(usage);
  }
  const loaded = loadPool(context.gateway().location.pool);
  if (loaded.usable) {
    for (const { name } of loaded.accounts) {
      io.say(`${provider} ${name}`);
    }
    return;
  }
  if (loaded.reason !== unconfiguredReason) {
    throw new CogError(loaded.reason);
  }
}

function utc(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? "an unknown time"
    : `${date.toISOString().slice(0, 19)}Z`;
}

function describeAccount(account: AccountSnapshot): string {
  const held =
    account.held && account.heldUntil !== null
      ? `held until ${utc(account.heldUntil)}`
      : "not held";
  const readings =
    account.buckets.length === 0
      ? ["no rate-limit reading"]
      : account.buckets.map(
          ({ bucket, utilization, expires }) =>
            `${bucket} ${String(Math.round(utilization * 100))}% until ${utc(expires)}`,
        );
  return [`${provider} ${account.name}`, held, ...readings].join("; ");
}

async function status(
  args: string[],
  context: AccountContext,
  io: AccountIo,
): Promise<void> {
  if (args.length > 0) {
    throw new CogError(usage);
  }
  let answer: PoolStatus;
  try {
    answer = await context.gateway().pool();
  } catch (error) {
    throw new CogError(
      `cannot read the pool state from the gateway: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (answer.state === "unconfigured") {
    io.say(
      `${unconfiguredReason}; add an account with: cog account add claude NAME`,
    );
    return;
  }
  if (answer.state === "unusable") {
    throw new CogError(
      `the Claude pool is not usable: ${answer.reason ?? "unknown reason"}`,
    );
  }
  for (const account of answer.accounts) {
    io.say(describeAccount(account));
  }
}

export async function accountCommand(
  args: string[],
  context: AccountContext,
  io: AccountIo = realIo,
): Promise<void> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "add":
      await add(rest, context, io);
      return;
    case "rm":
      await remove(rest, context, io);
      return;
    case "rename":
      await rename(rest, context, io);
      return;
    case "list":
      list(rest, context, io);
      return;
    case "status":
      await status(rest, context, io);
      return;
    default:
      throw new CogError(usage);
  }
}
