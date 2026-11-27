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
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { Control, controlOptions, locations } from "../gateway/control.ts";
import { logs } from "./commands/policy.ts";
import type { Context } from "./commands/context.ts";

interface Printed {
  id: string;
  kind: string;
  outcome: string;
  upstreamStatus: number | null;
  durationMs: number | null;
}

function nothing(): void {
  // A tick in which no request changes.
}

function requests(lines: string[]): Printed[] {
  return lines
    .map((line) => JSON.parse(line) as Printed)
    .filter((entry) => entry.kind === "request");
}

function setup() {
  const directory = mkdtempSync("/tmp/cog-");
  const control = new Control(locations({ COG_ROOT: directory }), {
    ...controlOptions({ COG_ROOT: directory }),
    actor: "tester",
  });
  onTestFinished(() => {
    control.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const instance = control.state.register(
    "lima:t1",
    path.join(directory, "t1.sock"),
    "tester",
  );
  const start = (id: string): void => {
    control.state.logDecision({
      id,
      instanceId: instance.id,
      repository: null,
      operation: "model.claude",
      refs: [],
      allowed: true,
      reason: "granted",
      revision: 0,
    });
  };
  const context = { gateway: () => control } as unknown as Context;
  const follow = async (
    steps: (() => void)[],
    mode = "--follow",
  ): Promise<Printed[]> => {
    const lines: string[] = [];
    let tick = 0;
    await assert.rejects(
      logs(["t1", mode], context, {
        emit: (line) => lines.push(line),
        pause: () => {
          const step = steps[tick++];
          if (step === undefined) {
            return Promise.reject(new Error("stop"));
          }
          step();
          return Promise.resolve();
        },
      }),
      /stop/,
    );
    return requests(lines);
  };
  return { control, start, follow, context };
}

test("follow prints a request again when it finishes", async () => {
  const { control, start, follow } = setup();
  start("a");
  const printed = await follow([
    () => {
      control.state.finish("a", 200, 5, "ok");
    },
    nothing,
  ]);
  assert.deepEqual(
    printed.map(({ id, outcome, upstreamStatus, durationMs }) => ({
      id,
      outcome,
      upstreamStatus,
      durationMs,
    })),
    [
      { id: "a", outcome: "unknown", upstreamStatus: null, durationMs: null },
      { id: "a", outcome: "ok", upstreamStatus: 200, durationMs: 5 },
    ],
  );
});

test("follow prints a finished request once, and never an unfinished one again", async () => {
  const { control, start, follow } = setup();
  start("done");
  control.state.finish("done", 200, 1, "ok");
  start("stuck");
  const printed = await follow([nothing, nothing]);
  assert.deepEqual(
    printed
      .map(({ id, outcome }) => `${id} ${outcome}`)
      .toSorted((left, right) => left.localeCompare(right)),
    ["done ok", "stuck unknown"],
  );
});

test("follow reprints a request that finishes after 100 newer ones", async () => {
  const { control, start, follow } = setup();
  start("old");
  const printed = await follow([
    () => {
      Bun.sleepSync(3);
      for (let index = 0; index < 120; index++) {
        start(`new-${String(index)}`);
        control.state.finish(`new-${String(index)}`, 200, 1, "ok");
      }
      control.state.finish("old", 200, 9, "ok");
    },
    nothing,
    nothing,
  ]);
  const old = printed.filter(({ id }) => id === "old");
  assert.deepEqual(
    old.map(({ outcome, durationMs }) => [outcome, durationMs]),
    [
      ["unknown", null],
      ["ok", 9],
    ],
  );
  assert.deepEqual(
    printed.slice(0, 2).map(({ id }) => id),
    ["old", "old"],
  );
});

test("logs without follow print an unfinished request once", async () => {
  const { start, context } = setup();
  start("a");
  const lines: string[] = [];
  await logs(["t1"], context, {
    emit: (line) => lines.push(line),
    pause: () => Promise.reject(new Error("no pause")),
  });
  assert.deepEqual(
    requests(lines).map(({ id, outcome }) => [id, outcome]),
    [["a", "unknown"]],
  );
});

test("logs print the oldest first", async () => {
  const { start, context } = setup();
  for (const id of ["c", "a", "b"]) {
    start(id);
    Bun.sleepSync(3);
  }
  const lines: string[] = [];
  await logs(["t1", "--all"], context, {
    emit: (line) => lines.push(line),
    pause: () => Promise.reject(new Error("no pause")),
  });
  assert.deepEqual(
    requests(lines).map(({ id }) => id),
    ["c", "a", "b"],
  );
});
