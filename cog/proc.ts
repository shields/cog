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

import { constants } from "node:os";
import path from "node:path";
import { CogError, CommandFailed, Interrupted } from "./errors.ts";

// Every child is an argv array with no host shell. Its environment is the
// parent's, unchanged except for what `env` adds.
export type Stdin = "ignore" | "inherit" | Uint8Array | { file: string };

export interface RunOptions {
  stdin?: Stdin;
  env?: Record<string, string>;
  cwd?: string;
  label?: string;
  quiet?: boolean;
  stdoutToStderr?: boolean;
}

const interruptions = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
} as const;

// A signal is recorded; a running child finishes, and then the next call
// throws Interrupted so that the cleanup in the callers' finally blocks runs.
export class Signals {
  #status: number | null = null;
  readonly #rejecters = new Set<(error: Interrupted) => void>();
  readonly #handlers = new Map<string, () => void>();

  install(): void {
    for (const [name, status] of Object.entries(interruptions)) {
      if (this.#handlers.has(name)) {
        continue;
      }
      const handler = (): void => {
        this.#status ??= status;
        const error = new Interrupted(this.#status);
        for (const reject of this.#rejecters) {
          reject(error);
        }
      };
      this.#handlers.set(name, handler);
      process.on(name, handler);
    }
  }

  uninstall(): void {
    for (const [name, handler] of this.#handlers) {
      process.off(name, handler);
    }
    this.#handlers.clear();
    this.#status = null;
  }

  get status(): number | null {
    return this.#status;
  }

  check(): void {
    if (this.#status !== null) {
      throw new Interrupted(this.#status);
    }
  }

  // For an await with no child to wait for: a signal rejects it at once.
  async race<T>(work: Promise<T>): Promise<T> {
    this.check();
    let reject: ((error: Interrupted) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, rejecter) => {
      reject = rejecter;
      this.#rejecters.add(rejecter);
    });
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      if (reject) {
        this.#rejecters.delete(reject);
      }
    }
  }
}

export const signals = new Signals();

function labelOf(argv: readonly string[], options: RunOptions): string {
  return options.label ?? path.basename(argv[0] ?? "command");
}

function environment(options: RunOptions): Record<string, string | undefined> {
  return options.env ? { ...process.env, ...options.env } : process.env;
}

function stdinOf(
  stdin: Stdin | undefined,
): "ignore" | "inherit" | Blob | ReturnType<typeof Bun.file> {
  if (stdin === undefined || stdin === "ignore") {
    return "ignore";
  }
  if (stdin === "inherit") {
    return "inherit";
  }
  if (stdin instanceof Uint8Array) {
    return new Blob([Buffer.from(stdin)]);
  }
  return Bun.file(stdin.file);
}

interface Child {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

function spawn(
  argv: readonly string[],
  options: RunOptions,
  stdout: "inherit" | "ignore" | "pipe" | 2,
  stdin: unknown = stdinOf(options.stdin),
): Child {
  signals.check();
  const [program, ...rest] = argv;
  if (program === undefined) {
    throw new CogError("no command to run");
  }
  try {
    return Bun.spawn([program, ...rest], {
      stdin: stdin as "ignore",
      stdout,
      stderr: options.quiet ? "ignore" : "inherit",
      env: environment(options),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }) as unknown as Child;
  } catch {
    throw new CogError(`cannot run ${path.basename(program)}`);
  }
}

function statusOf(child: Child): number {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  const number = child.signalCode
    ? (constants.signals as Record<string, number | undefined>)[
        child.signalCode
      ]
    : undefined;
  return 128 + (number ?? 0);
}

function stdoutOf(options: RunOptions): "inherit" | "ignore" | 2 {
  if (options.quiet) {
    return "ignore";
  }
  return options.stdoutToStderr ? 2 : "inherit";
}

// Resolves to the exit status, for a caller that treats failure as an answer.
export async function runStatus(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<number> {
  const child = spawn(argv, options, stdoutOf(options));
  await child.exited;
  signals.check();
  return statusOf(child);
}

export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<void> {
  const status = await runStatus(argv, options);
  if (status !== 0) {
    throw new CommandFailed(labelOf(argv, options), status);
  }
}

// The standard output of the child, without the newlines at the end.
export async function capture(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const child = spawn(argv, options, "pipe");
  const output = new Response(child.stdout).text();
  await child.exited;
  const text = await output;
  signals.check();
  const status = statusOf(child);
  if (status !== 0) {
    throw new CommandFailed(labelOf(argv, options), status);
  }
  return text.replace(/\n+$/, "");
}

// producer | consumer: either failing fails the pipeline.
export async function pipe(
  producer: readonly string[],
  consumer: readonly string[],
  options: {
    producer?: RunOptions;
    consumer?: RunOptions;
  } = {},
): Promise<void> {
  const first = spawn(producer, options.producer ?? {}, "pipe");
  let second: Child;
  try {
    second = spawn(
      consumer,
      options.consumer ?? {},
      stdoutOf(options.consumer ?? {}),
      first.stdout,
    );
  } catch (error) {
    first.kill();
    await first.exited;
    throw error;
  }
  await Promise.all([first.exited, second.exited]);
  signals.check();
  const consumed = statusOf(second);
  if (consumed !== 0) {
    throw new CommandFailed(
      labelOf(consumer, options.consumer ?? {}),
      consumed,
    );
  }
  const produced = statusOf(first);
  if (produced !== 0) {
    throw new CommandFailed(
      labelOf(producer, options.producer ?? {}),
      produced,
    );
  }
}

// Replaces this process, keeping its PID, terminal and environment.
export function replace(argv: readonly string[]): never {
  const [program, ...rest] = argv;
  if (program === undefined || !path.isAbsolute(program)) {
    throw new CogError("cannot replace the process without an absolute path");
  }
  if (typeof process.execve !== "function") {
    throw new CogError("this runtime cannot replace the process");
  }
  process.execve(program, [program, ...rest], process.env);
  throw new CogError("cannot replace the process");
}
