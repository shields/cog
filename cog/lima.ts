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

import path from "node:path";
import { CogError } from "./errors.ts";
import {
  capture,
  pipe,
  replace,
  run,
  runStatus,
  type RunOptions,
  type Stdin,
} from "./proc.ts";

export interface ShellOptions {
  quiet?: boolean;
  workdir?: string;
  stdin?: Stdin;
}

// The calls to limactl, one method each. Every call reads no standard input
// unless a method says otherwise.
export interface Lima {
  list(): Promise<void>;
  // limactl list exits non-zero when no instance matches the name.
  exists(name: string): Promise<boolean>;
  hasGatewaySocket(name: string, socket: string): Promise<boolean>;
  isProtected(name: string): Promise<boolean>;
  unprotect(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  create(
    name: string,
    size: readonly string[],
    template: string,
  ): Promise<void>;
  mountCount(name: string): Promise<string>;
  clone(base: string, name: string, size: readonly string[]): Promise<void>;
  edit(name: string, expression: string): Promise<void>;
  boot(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  setShell(name: string, shell: string): Promise<void>;
  protect(name: string): Promise<void>;
  guestHome(name: string): Promise<string>;
  shell(
    name: string,
    command: readonly string[],
    options?: ShellOptions,
  ): Promise<void>;
  shellOutput(name: string, command: readonly string[]): Promise<string>;
  // What the other end of a pipe runs, for pipe().
  shellArgv(
    name: string,
    command: readonly string[],
    options?: ShellOptions,
  ): string[];
  pipeInto(
    producer: readonly string[],
    name: string,
    command: readonly string[],
    options?: { producer?: RunOptions },
  ): Promise<void>;
  // The final shell takes over this process.
  enter(name: string, workdir?: string): Promise<number>;
}

export function findLimactl(): string {
  const found = Bun.which("limactl", { PATH: process.env.PATH ?? "" });
  if (found === null) {
    throw new CogError("limactl is not installed");
  }
  return path.resolve(found);
}

export function createLima(limactl: string): Lima {
  const label = (subcommand: string): RunOptions => ({
    label: `limactl ${subcommand}`,
  });
  const call = async (
    subcommand: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<void> => {
    await run([limactl, subcommand, ...args], {
      ...label(subcommand),
      ...options,
    });
  };
  const output = (
    subcommand: string,
    args: readonly string[],
  ): Promise<string> =>
    capture([limactl, subcommand, ...args], label(subcommand));
  const shellArgs = (
    name: string,
    command: readonly string[],
    options: ShellOptions = {},
  ): string[] => [
    ...(options.workdir === undefined ? [] : ["--workdir", options.workdir]),
    name,
    ...command,
  ];
  const shellArgv = (
    name: string,
    command: readonly string[],
    options: ShellOptions = {},
  ): string[] => [limactl, "shell", ...shellArgs(name, command, options)];
  return {
    list: () => call("list", []),
    exists: async (name) =>
      (await runStatus([limactl, "list", "-q", name], { quiet: true })) === 0,
    hasGatewaySocket: async (name, socket) => {
      const forwards = await output("list", [
        "--format",
        '{{range .Config.PortForwards}}{{if .Reverse}}{{printf "%s\\t%s\\n" $.Name .HostSocket}}{{end}}{{end}}',
      ]);
      return forwards.split("\n").includes(`${name}\t${socket}`);
    },
    isProtected: async (name) =>
      (await output("list", ["--format", "{{.Protected}}", name])) === "true",
    unprotect: (name) => call("unprotect", [name]),
    remove: (name) => call("delete", ["--tty=false", "--force", name]),
    create: (name, size, template) =>
      call("start", ["--tty=false", `--name=${name}`, ...size, template]),
    mountCount: (name) =>
      output("list", ["--format", "{{len .Config.Mounts}}", name]),
    clone: (base, name, size) =>
      call("clone", ["--tty=false", ...size, base, name]),
    edit: (name, expression) =>
      call("edit", ["--tty=false", "--set", expression, name]),
    boot: (name) => call("start", ["--tty=false", name]),
    stop: (name) => call("stop", ["--tty=false", name]),
    setShell: (name, shell) =>
      call("edit", ["--tty=false", name, "--shell", shell]),
    protect: (name) => call("protect", [name]),
    guestHome: async (name) => {
      const home = await capture(
        shellArgv(name, ["sh", "-c", 'printf %s "$HOME"']),
        label("shell"),
      );
      if (!home.startsWith("/")) {
        throw new CogError(`cannot tell the home directory in ${name}`);
      }
      return home;
    },
    shell: async (name, command, options = {}) => {
      await call("shell", shellArgs(name, command, options), {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.quiet ? { quiet: true } : {}),
      });
    },
    shellOutput: (name, command) =>
      capture(shellArgv(name, command), label("shell")),
    shellArgv,
    pipeInto: (producer, name, command, options = {}) =>
      pipe(producer, shellArgv(name, command), {
        ...(options.producer ? { producer: options.producer } : {}),
        consumer: label("shell"),
      }),
    enter: async (name, workdir) => {
      const argv = shellArgv(
        name,
        [],
        workdir === undefined ? {} : { workdir },
      );
      try {
        replace(argv);
      } catch {
        return await runStatus(argv, { ...label("shell"), stdin: "inherit" });
      }
    },
  };
}
