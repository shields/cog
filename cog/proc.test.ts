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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, onTestFinished, test } from "bun:test";
import { CogError, CommandFailed, Interrupted } from "./errors.ts";
import { capture, pipe, run, runStatus, signals } from "./proc.ts";

function directory(): string {
  const result = mkdtempSync(path.join(os.tmpdir(), "cog-proc-"));
  onTestFinished(() => {
    rmSync(result, { recursive: true, force: true });
  });
  return result;
}

async function failure(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof Error, String(error));
    return error;
  }
  return assert.fail("expected a failure");
}

afterEach(() => {
  signals.uninstall();
});

describe("run", () => {
  test("succeeds on status 0", async () => {
    await run(["/usr/bin/true"]);
  });

  test("throws the child's status under the program's name, never its arguments", async () => {
    const error = await failure(() =>
      run(["/bin/sh", "-c", "exit 7", "COG_SECRET_MARKER"]),
    );
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 7);
    assert.equal(error.message, "sh failed with status 7");
  });

  test("takes a label for the message", async () => {
    const error = await failure(() =>
      run(["/bin/sh", "-c", "exit 3"], { label: "limactl start" }),
    );
    assert.equal(error.message, "limactl start failed with status 3");
  });

  test("reports a child that a signal killed as 128 plus the signal", async () => {
    const error = await failure(() => run(["/bin/sh", "-c", "kill -TERM $$"]));
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 143);
  });

  test("a program that cannot start is a fixed message", async () => {
    const error = await failure(() => run(["/nonexistent/COG_MARKER/tool"]));
    assert.ok(error instanceof CogError);
    assert.equal(error.message, "cannot run tool");
  });

  test("runStatus returns a failure as the answer", async () => {
    assert.equal(await runStatus(["/bin/sh", "-c", "exit 5"]), 5);
    assert.equal(
      await runStatus(["/bin/sh", "-c", "echo hidden >&2; exit 1"], {
        quiet: true,
      }),
      1,
    );
  });
});

describe("standard input", () => {
  test("is empty unless something is meant for the child", async () => {
    assert.equal(await capture(["/bin/cat"]), "");
    assert.equal(await capture(["/bin/cat"], { stdin: "ignore" }), "");
  });

  test("is the bytes given, unchanged", async () => {
    const bytes = Uint8Array.from([0x61, 0xff, 0x00, 0x0a, 0x62]);
    const file = path.join(directory(), "out");
    await run(["/bin/sh", "-c", 'cat > "$1"', "sh", file], { stdin: bytes });
    assert.deepEqual(new Uint8Array(readFileSync(file)), bytes);
  });

  test("is a file", async () => {
    const dir = directory();
    const input = path.join(dir, "in");
    writeFileSync(input, "from a file\n");
    assert.equal(
      await capture(["/bin/cat"], { stdin: { file: input } }),
      "from a file",
    );
  });
});

describe("the environment", () => {
  test("is the parent's, unchanged", async () => {
    process.env.COG_TEST_INHERITED = "kept";
    onTestFinished(() => {
      delete process.env.COG_TEST_INHERITED;
    });
    assert.equal(
      await capture(["/bin/sh", "-c", 'printf %s "$COG_TEST_INHERITED"']),
      "kept",
    );
  });

  test("gains what env adds and loses nothing", async () => {
    process.env.COG_TEST_INHERITED = "kept";
    onTestFinished(() => {
      delete process.env.COG_TEST_INHERITED;
    });
    assert.equal(
      await capture(
        [
          "/bin/sh",
          "-c",
          'printf "%s %s" "$COG_TEST_INHERITED" "$COG_TEST_ADDED"',
        ],
        { env: { COG_TEST_ADDED: "added" } },
      ),
      "kept added",
    );
    assert.equal(process.env.COG_TEST_ADDED, undefined);
  });
});

describe("capture", () => {
  test("drops the newlines at the end, as $(...) does", async () => {
    assert.equal(await capture(["/usr/bin/printf", "a\nb\n\n\n"]), "a\nb");
    assert.equal(await capture(["/usr/bin/printf", ""]), "");
  });

  test("throws the status of a failing child", async () => {
    const error = await failure(() =>
      capture(["/bin/sh", "-c", "echo out; exit 4"]),
    );
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 4);
  });
});

describe("pipe", () => {
  const consume = (file: string): string[] => [
    "/bin/sh",
    "-c",
    'cat > "$1"',
    "sh",
    file,
  ];

  test("carries the producer's output to the consumer", async () => {
    const file = path.join(directory(), "out");
    await pipe(["/usr/bin/printf", "hello\\000\\377"], consume(file));
    assert.deepEqual(
      new Uint8Array(readFileSync(file)),
      Uint8Array.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff]),
    );
  });

  test("fails when the consumer fails", async () => {
    const error = await failure(() =>
      pipe(
        ["/usr/bin/printf", "x"],
        ["/bin/sh", "-c", "cat >/dev/null; exit 6"],
      ),
    );
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 6);
  });

  test("fails when the producer fails, as pipefail does", async () => {
    const file = path.join(directory(), "out");
    const error = await failure(() =>
      pipe(["/bin/sh", "-c", "printf x; exit 9"], consume(file), {
        producer: { label: "tar" },
      }),
    );
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 9);
    assert.equal(error.message, "tar failed with status 9");
  });

  test("reports the consumer's status when both fail", async () => {
    const error = await failure(() =>
      pipe(
        ["/bin/sh", "-c", "exit 9"],
        ["/bin/sh", "-c", "cat >/dev/null; exit 6"],
      ),
    );
    assert.ok(error instanceof CommandFailed);
    assert.equal(error.status, 6);
  });
});

describe("signals", () => {
  test("a child's signal can arrive before the parent's signal handler", async () => {
    signals.install();
    const error = await failure(() =>
      capture(["/bin/sh", "-c", "kill -HUP $$"]),
    );
    assert.ok(error instanceof Interrupted);
    assert.equal(error.status, 129);
    assert.equal(signals.status, 129);
  });

  test("a signal lets the running child finish, then ends the next call", async () => {
    signals.install();
    const started = performance.now();
    const running = run(["/bin/sh", "-c", "sleep 0.3"]);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    process.emit("SIGTERM", "SIGTERM");
    const error = await failure(() => running);
    assert.ok(error instanceof Interrupted);
    assert.equal(error.status, 143);
    assert.ok(performance.now() - started >= 250);
    assert.equal(signals.status, 143);
    const next = await failure(() => run(["/usr/bin/true"]));
    assert.ok(next instanceof Interrupted);
    assert.throws(() => {
      signals.check();
    }, Interrupted);
  });

  test.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGQUIT", 131],
    ["SIGTERM", 143],
  ] as const)(
    "%s is status %i, and the first signal's status stays",
    (name, status) => {
      signals.install();
      process.emit(name, name);
      assert.equal(signals.status, status);
      process.emit("SIGHUP", "SIGHUP");
      assert.equal(signals.status, status);
    },
  );

  test("a signal rejects an await that has no child to wait for", async () => {
    signals.install();
    const { promise: never } = Promise.withResolvers<never>();
    const waiting = signals.race(never);
    process.emit("SIGINT", "SIGINT");
    const error = await failure(() => waiting);
    assert.ok(error instanceof Interrupted);
    assert.equal(error.status, 130);
  });

  test("race passes the result through when nothing arrives", async () => {
    signals.install();
    assert.equal(await signals.race(Promise.resolve(5)), 5);
    assert.equal(signals.status, null);
  });

  test("uninstalling forgets the signal and removes the handlers", async () => {
    signals.install();
    process.emit("SIGINT", "SIGINT");
    signals.uninstall();
    assert.equal(signals.status, null);
    assert.equal(process.listenerCount("SIGINT"), 0);
    await run(["/usr/bin/true"]);
  });
});

describe("replace", () => {
  const script = (code: string): string[] => [
    process.execPath,
    "-e",
    `const { replace } = await import(process.env.COG_TEST_PROC); ${code}`,
  ];
  const proc = path.join(import.meta.dirname, "proc.ts");

  test("keeps the PID, the argv and the environment", async () => {
    const child = Bun.spawn(
      script(
        'replace(["/bin/sh", "-c", "printf \\"%s %s\\" \\"$$\\" \\"$COG_TEST_PROC\\""]);',
      ),
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, COG_TEST_PROC: proc },
      },
    );
    const output = await new Response(child.stdout).text();
    assert.equal(await child.exited, 0);
    assert.equal(output, `${String(child.pid)} ${proc}`);
  });

  test("passes the status of the new program", async () => {
    const child = Bun.spawn(script('replace(["/bin/sh", "-c", "exit 12"]);'), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, COG_TEST_PROC: proc },
    });
    assert.equal(await child.exited, 12);
  });

  test("refuses a path that is not absolute", async () => {
    const { replace } = await import("./proc.ts");
    assert.throws(
      () => replace(["sh", "-c", "true"]),
      (error: unknown) =>
        error instanceof CogError &&
        error.message === "cannot replace the process without an absolute path",
    );
  });
});
