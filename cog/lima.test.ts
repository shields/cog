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

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { CogError, CommandFailed } from "./errors.ts";
import { createLima, findLimactl } from "./lima.ts";

interface Stub {
  limactl: string;
  calls: () => string[][];
  stdin: () => string;
}

// The stub records each call's arguments, one per line with a blank line
// between calls, and what it read from standard input. STUB_OUT is what it
// prints and STUB_STATUS the status it exits with.
function stub(): Stub {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cog-lima-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const limactl = path.join(dir, "limactl");
  writeFileSync(
    limactl,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "${dir}/calls"; done
printf '\\n' >> "${dir}/calls"
cat >> "${dir}/stdin"
[ -z "\${STUB_OUT:-}" ] || printf '%s\\n\\n' "$STUB_OUT"
exit "\${STUB_STATUS:-0}"
`,
  );
  chmodSync(limactl, 0o755);
  const read = (name: string): string => {
    try {
      return readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    limactl,
    calls: () =>
      read("calls")
        .split("\n\n")
        .filter((call) => call !== "")
        .map((call) => call.split("\n")),
    stdin: () => read("stdin"),
  };
}

test("each method calls limactl with the expected arguments", async () => {
  const { limactl, calls } = stub();
  const lima = createLima(limactl);
  await lima.list();
  await lima.unprotect("b");
  await lima.remove("b");
  await lima.create("b", ["--cpus", "4"], "/s/dev.yaml");
  await lima.create("b", [], "/s/dev.yaml");
  await lima.clone("b", "t1", ["--memory", "8"]);
  await lima.edit("t1", ".x = 1");
  await lima.boot("t1");
  await lima.stop("b");
  await lima.setShell("b", "/usr/bin/zsh");
  await lima.protect("b");
  await lima.shell("t1", ["sudo", "x"]);
  await lima.shell("t1", ["./provision.sh", "dev"], { workdir: "/g" });
  assert.deepEqual(calls(), [
    ["list"],
    ["unprotect", "b"],
    ["delete", "--tty=false", "--force", "b"],
    ["start", "--tty=false", "--name=b", "--cpus", "4", "/s/dev.yaml"],
    ["start", "--tty=false", "--name=b", "/s/dev.yaml"],
    ["clone", "--tty=false", "--memory", "8", "b", "t1"],
    ["edit", "--tty=false", "--set", ".x = 1", "t1"],
    ["start", "--tty=false", "t1"],
    ["stop", "--tty=false", "b"],
    ["edit", "--tty=false", "b", "--shell", "/usr/bin/zsh"],
    ["protect", "b"],
    ["shell", "t1", "sudo", "x"],
    ["shell", "--workdir", "/g", "t1", "./provision.sh", "dev"],
  ]);
});

test("the queries pass the formats and return the output without trailing newlines", async () => {
  const { limactl, calls } = stub();
  const lima = createLima(limactl);
  process.env.STUB_OUT = "true";
  onTestFinished(() => {
    delete process.env.STUB_OUT;
  });
  assert.equal(await lima.isProtected("b"), true);
  process.env.STUB_OUT = "false";
  assert.equal(await lima.isProtected("b"), false);
  process.env.STUB_OUT = "0";
  assert.equal(await lima.mountCount("b"), "0");
  process.env.STUB_OUT = "/home/x/.lima/t1";
  assert.equal(await lima.directory("t1"), "/home/x/.lima/t1");
  assert.deepEqual(calls(), [
    ["list", "--format", "{{.Protected}}", "b"],
    ["list", "--format", "{{.Protected}}", "b"],
    ["list", "--format", "{{len .Config.Mounts}}", "b"],
    ["list", "--format", "{{.Dir}}", "t1"],
  ]);
});

test("exists is the status of list -q, and any failure is absent", async () => {
  const { limactl, calls } = stub();
  const lima = createLima(limactl);
  assert.equal(await lima.exists("t1"), true);
  process.env.STUB_STATUS = "1";
  onTestFinished(() => {
    delete process.env.STUB_STATUS;
  });
  assert.equal(await lima.exists("t1"), false);
  assert.deepEqual(calls(), [
    ["list", "-q", "t1"],
    ["list", "-q", "t1"],
  ]);
});

test("a failing call names the subcommand and keeps the status", async () => {
  const { limactl } = stub();
  const lima = createLima(limactl);
  process.env.STUB_STATUS = "5";
  onTestFinished(() => {
    delete process.env.STUB_STATUS;
  });
  for (const [work, label] of [
    [() => lima.boot("t1"), "limactl start"],
    [() => lima.remove("t1"), "limactl delete"],
    [() => lima.shell("t1", ["x"]), "limactl shell"],
    [() => lima.isProtected("t1"), "limactl list"],
  ] as const) {
    await assert.rejects(work(), (error: unknown) => {
      assert.ok(error instanceof CommandFailed);
      assert.equal(error.status, 5);
      assert.equal(error.message, `${label} failed with status 5`);
      return true;
    });
  }
});

test("guestHome asks the guest and wants an absolute path", async () => {
  const { limactl, calls } = stub();
  const lima = createLima(limactl);
  process.env.STUB_OUT = "/home/shields.guest";
  onTestFinished(() => {
    delete process.env.STUB_OUT;
  });
  assert.equal(await lima.guestHome("t1"), "/home/shields.guest");
  assert.deepEqual(calls(), [["shell", "t1", "sh", "-c", 'printf %s "$HOME"']]);
  process.env.STUB_OUT = "home";
  await assert.rejects(
    lima.guestHome("t1"),
    (error: unknown) =>
      error instanceof CogError &&
      error.message === "cannot tell the home directory in t1",
  );
});

test("a call reads no standard input unless it is given some", async () => {
  const { limactl, stdin } = stub();
  const lima = createLima(limactl);
  await lima.shell("t1", ["x"]);
  await lima.stop("t1");
  assert.equal(stdin(), "");
  await lima.shell("t1", ["setup-secrets", "NAME"], {
    stdin: new TextEncoder().encode("secret-on-stdin\n"),
  });
  assert.equal(stdin(), "secret-on-stdin\n");
});

test("a pipe feeds a producer into limactl shell", async () => {
  const { limactl, calls, stdin } = stub();
  const lima = createLima(limactl);
  await lima.pipeInto(["/usr/bin/printf", "tree"], "t1", ["tar", "-x"], {
    producer: { label: "tar" },
  });
  assert.deepEqual(calls(), [["shell", "t1", "tar", "-x"]]);
  assert.equal(stdin(), "tree");
  assert.deepEqual(lima.shellArgv("t1", ["a"], { workdir: "/w" }), [
    limactl,
    "shell",
    "--workdir",
    "/w",
    "t1",
    "a",
  ]);
});

test("the terminal and PID survive handoff to the interactive shell", async () => {
  const { limactl } = stub();
  writeFileSync(
    limactl,
    `#!/bin/sh
set -eu
[ -t 0 ] && [ -t 1 ] && [ -t 2 ]
[ "$*" = "shell --workdir /work t1" ]
printf 'ready:%s\\n' "$$"
IFS= read -r input
[ "$input" = 'from terminal' ]
exit 17
`,
  );
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let output = "";
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { createLima } from ${JSON.stringify(path.join(import.meta.dirname, "lima.ts"))};
    process.exitCode = await createLima(${JSON.stringify(limactl)}).enter("t1", "/work");`,
    ],
    {
      terminal: {
        data: (_terminal, bytes) => {
          output += Buffer.from(bytes).toString("utf8");
          if (/ready:\d+\r?\n/.test(output)) {
            resolve(true);
          }
        },
      },
    },
  );
  onTestFinished(() => {
    child.kill();
    child.terminal?.close();
  });
  const exitedEarly = async (): Promise<never> => {
    const status = await child.exited;
    assert.fail(`shell exited before reading: ${String(status)} (${output})`);
  };
  await Promise.race([promise, exitedEarly()]);
  assert.match(output, new RegExp(String.raw`ready:${String(child.pid)}\r?\n`));
  assert.ok(child.terminal);
  child.terminal.write("from terminal\n");
  assert.equal(await child.exited, 17, output);
});

test("findLimactl resolves through PATH once, to an absolute path", () => {
  const { limactl } = stub();
  const previous = process.env.PATH;
  process.env.PATH = path.dirname(limactl);
  try {
    assert.equal(findLimactl(), limactl);
    process.env.PATH = "/nonexistent";
    assert.throws(
      () => findLimactl(),
      (error: unknown) =>
        error instanceof CogError &&
        error.message === "limactl is not installed",
    );
  } finally {
    process.env.PATH = previous;
  }
});

test("a cleanup retry recognizes only the reverse socket belonging to the saved clone", async () => {
  const { limactl } = stub();
  const original = process.env.STUB_OUT;
  try {
    process.env.STUB_OUT =
      "other\t/path with spaces/original.sock\nvm\t/another.sock";
    const lima = createLima(limactl);
    assert.equal(
      await lima.hasGatewaySocket("vm", "/path with spaces/original.sock"),
      false,
    );
    assert.equal(
      await lima.hasGatewaySocket("other", "/path with spaces/original.sock"),
      true,
    );
  } finally {
    if (original === undefined) delete process.env.STUB_OUT;
    else process.env.STUB_OUT = original;
  }
});
