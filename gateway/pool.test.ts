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
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, onTestFinished, spyOn, test } from "bun:test";
import {
  AccountPool,
  loadPool,
  unconfiguredReason,
  type Account,
  type PoolLoad,
} from "./pool.ts";

afterEach(() => {
  process.stderr.write = original;
});

const original = process.stderr.write.bind(process.stderr);

function captureStderr(): string[] {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string) => {
    lines.push(chunk);
    return true;
  });
  return lines;
}

const marker = "zq7x-made-up-part";
const goodToken = `sk-ant-oat01-${marker}`;

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-pool-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function makePool(
  files: Record<string, string>,
  directoryMode = 0o700,
): string {
  const directory = path.join(scratch(), "claude-pool");
  mkdirSync(directory);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    writeFileSync(file, content);
    chmodSync(file, 0o600);
  }
  chmodSync(directory, directoryMode);
  return directory;
}

function reason(load: PoolLoad): string {
  if (load.usable) {
    assert.fail("the pool is usable");
  }
  return load.reason;
}

function accountsOf(load: PoolLoad): Account[] {
  if (!load.usable) {
    assert.fail(load.reason);
  }
  return load.accounts;
}

function names(load: PoolLoad): string[] {
  return accountsOf(load).map(({ name }) => name);
}

test("a pool directory of well-formed account files loads, in name order", () => {
  const directory = makePool({
    zed: `${goodToken}\n`,
    "a-1": goodToken,
    "0": "sk-ant-oat01-other",
  });
  const load = loadPool(directory);
  assert.deepEqual(load, {
    usable: true,
    accounts: [
      { name: "0", token: "sk-ant-oat01-other" },
      { name: "a-1", token: goodToken },
      { name: "zed", token: goodToken },
    ],
  });
});

test("names of one and of thirty-two characters, and tokens of the longest length, are accepted", () => {
  const longest = `sk-ant-oat${"x".repeat(4096 - 10)}`;
  assert.equal(longest.length, 4096);
  const directory = makePool({
    a: "sk-ant-oat",
    ["a" + "-b".repeat(15) + "c"]: longest,
    z0: `${longest}\n`,
  });
  assert.equal(
    accountsOf(loadPool(directory)).find(({ name }) => name === "z0")?.token,
    longest,
  );
});

test("a token may hold every visible ASCII character after its prefix", () => {
  const visible = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
    String.fromCodePoint(0x21 + index),
  ).join("");
  const token = `sk-ant-oat${visible}`;
  const directory = makePool({ a: token, b: `${token}\n` });
  assert.deepEqual(accountsOf(loadPool(directory)), [
    { name: "a", token },
    { name: "b", token },
  ]);
});

test("entries whose names start with a dot are ignored, whatever they are", () => {
  const directory = makePool({
    ok: goodToken,
    ".ok.tmp": "not a token at all\nsecond line",
    ".empty": "",
  });
  mkdirSync(path.join(directory, ".dir"));
  symlinkSync("/nonexistent", path.join(directory, ".link"));
  writeFileSync(path.join(directory, ".open"), goodToken, { mode: 0o666 });
  chmodSync(path.join(directory, ".open"), 0o666);
  assert.deepEqual(names(loadPool(directory)), ["ok"]);
});

test("a missing directory is a pool that is not configured, and a file, a symbolic link and a directory open to group or other are refused", () => {
  const base = scratch();
  assert.equal(
    reason(loadPool(path.join(base, "missing"))),
    unconfiguredReason,
  );
  writeFileSync(path.join(base, "file"), goodToken);
  assert.equal(
    reason(loadPool(path.join(base, "file"))),
    "the Claude pool location is not a real directory",
  );
  const real = makePool({ a: goodToken });
  symlinkSync(real, path.join(base, "link"));
  assert.equal(
    reason(loadPool(path.join(base, "link"))),
    "the Claude pool location is not a real directory",
  );
  assert.equal(loadPool(real).usable, true);
  for (const mode of [0o750, 0o705, 0o770, 0o707, 0o755, 0o777, 0o710, 0o701]) {
    const open = makePool({ a: goodToken }, mode);
    assert.equal(
      reason(loadPool(open)),
      "the Claude pool directory is accessible to group or other",
      mode.toString(8),
    );
  }
});

test("a directory with no account is a pool that is not configured, and so is one that holds only ignored entries", () => {
  assert.equal(reason(loadPool(makePool({}))), unconfiguredReason);
  assert.equal(
    reason(loadPool(makePool({ ".tmp": goodToken }))),
    unconfiguredReason,
  );
});

test("each rule on an account file refuses the whole pool, even beside a good account", () => {
  const cases: [string, () => string, string][] = [
    [
      "a symbolic link",
      () => {
        const directory = makePool({ good: goodToken });
        const target = path.join(scratch(), "target");
        writeFileSync(target, goodToken);
        chmodSync(target, 0o600);
        symlinkSync(target, path.join(directory, "link"));
        return directory;
      },
      "account link is not a regular file",
    ],
    [
      "a directory",
      () => {
        const directory = makePool({ good: goodToken });
        mkdirSync(path.join(directory, "sub"), { mode: 0o700 });
        return directory;
      },
      "account sub is not a regular file",
    ],
    [
      "a file readable by group",
      () => {
        const directory = makePool({ good: goodToken, bad: goodToken });
        chmodSync(path.join(directory, "bad"), 0o640);
        return directory;
      },
      "account bad is accessible to group or other",
    ],
    [
      "a file readable by other",
      () => {
        const directory = makePool({ good: goodToken, bad: goodToken });
        chmodSync(path.join(directory, "bad"), 0o604);
        return directory;
      },
      "account bad is accessible to group or other",
    ],
    [
      "a file writable by group",
      () => {
        const directory = makePool({ good: goodToken, bad: goodToken });
        chmodSync(path.join(directory, "bad"), 0o620);
        return directory;
      },
      "account bad is accessible to group or other",
    ],
    [
      "an upper-case name",
      () => makePool({ good: goodToken, Bad: goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "a name with a dot inside",
      () => makePool({ good: goodToken, "a.b": goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "a name with an underscore",
      () => makePool({ good: goodToken, a_b: goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "a name that starts with a dash",
      () => makePool({ good: goodToken, "-a": goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "a name of thirty-three characters",
      () => makePool({ good: goodToken, ["a".repeat(33)]: goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "a name with a space",
      () => makePool({ good: goodToken, "a b": goodToken }),
      "an entry has a name that is not allowed",
    ],
    [
      "an empty file",
      () => makePool({ good: goodToken, bad: "" }),
      "account bad must hold one token of at most 4096 characters",
    ],
    [
      "a file of one newline",
      () => makePool({ good: goodToken, bad: "\n" }),
      "account bad must hold one token of at most 4096 characters",
    ],
    [
      "two lines",
      () =>
        makePool({ good: goodToken, bad: `${goodToken}\nsk-ant-oat01-b\n` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "two trailing newlines",
      () => makePool({ good: goodToken, bad: `${goodToken}\n\n` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a leading newline",
      () => makePool({ good: goodToken, bad: `\n${goodToken}` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a trailing space",
      () => makePool({ good: goodToken, bad: `${goodToken} ` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a trailing space and newline",
      () => makePool({ good: goodToken, bad: `${goodToken} \n` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a carriage return",
      () => makePool({ good: goodToken, bad: `${goodToken}\r\n` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a space inside",
      () => makePool({ good: goodToken, bad: `sk-ant-oat01-a ${marker}` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a byte above ASCII",
      () => makePool({ good: goodToken, bad: `sk-ant-oat01-\u{E9}${marker}` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "a delete character",
      () => makePool({ good: goodToken, bad: `sk-ant-oat01-\u{7F}${marker}` }),
      "account bad must hold one token of visible ASCII characters",
    ],
    [
      "the wrong prefix",
      () => makePool({ good: goodToken, bad: `sk-ant-api03-${marker}` }),
      "account bad must hold a token that starts with sk-ant-oat",
    ],
    [
      "a prefix that is only almost right",
      () => makePool({ good: goodToken, bad: `sk-ant-oa-${marker}` }),
      "account bad must hold a token that starts with sk-ant-oat",
    ],
    [
      "a token of 4097 characters",
      () =>
        makePool({
          good: goodToken,
          bad: `sk-ant-oat${marker}${"x".repeat(4097 - 10 - marker.length)}`,
        }),
      "account bad must hold one token of at most 4096 characters",
    ],
    [
      "a file far larger than any token",
      () =>
        makePool({
          good: goodToken,
          bad: `sk-ant-oat${marker}${"x".repeat(100_000)}`,
        }),
      "account bad is larger than a token",
    ],
  ];
  for (const [name, build, expected] of cases) {
    const load = loadPool(build());
    assert.equal(reason(load), expected, name);
    assert.ok(!reason(load).includes(marker), name);
  }
});

test("a reason never holds file content, and names an entry only when its name is a valid account name", () => {
  const directory = makePool({
    good: goodToken,
    "Secret-Name": marker,
  });
  assert.ok(!reason(loadPool(directory)).includes("Secret-Name"));
  for (const content of [
    marker,
    `${marker}\n${marker}`,
    `sk-ant-api03-${marker}`,
    `sk-ant-oat01-${marker} `,
    `sk-ant-oat01-${marker}\u{E9}`,
    "x".repeat(5000) + marker,
  ]) {
    const message = reason(loadPool(makePool({ bad: content })));
    assert.ok(message.startsWith("account bad "), message);
    assert.ok(!message.includes(marker), message);
    assert.ok(!message.includes("sk-ant-api03"), message);
  }
});

test("an unreadable account file is refused by its code, not its content", () => {
  const directory = makePool({ bad: goodToken });
  const read = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw Object.assign(new Error(`EIO: i/o error, read ${marker}`), {
      code: "EIO",
    });
  });
  onTestFinished(() => {
    read.mockRestore();
  });
  assert.equal(reason(loadPool(directory)), "account bad cannot be read (EIO)");
});

test("a pool directory that cannot be examined or listed is refused by its code, not read as a pool that is not configured", () => {
  const base = scratch();
  writeFileSync(path.join(base, "file"), goodToken);
  assert.equal(
    reason(loadPool(path.join(base, "file", "claude-pool"))),
    "the Claude pool directory cannot be read (ENOTDIR)",
  );
  const directory = makePool({ a: goodToken });
  const list = spyOn(fs, "readdirSync").mockImplementation(() => {
    throw Object.assign(
      new Error(`EPERM: operation not permitted, scandir ${marker}`),
      { code: "EPERM" },
    );
  });
  onTestFinished(() => {
    list.mockRestore();
  });
  assert.equal(
    reason(loadPool(directory)),
    "the Claude pool directory cannot be read (EPERM)",
  );
});

const start = 1_800_000_000_000;
const second = 1000;
const hour = 3_600_000;
const day = 86_400_000;

function tokenOf(name: string): string {
  return `sk-ant-oat01-${name}-${marker}`;
}

function makeAccounts(...names: string[]): { name: string; token: string }[] {
  return names.map((name) => ({ name, token: tokenOf(name) }));
}

function rank(instanceId: string, name: string): string {
  return createHash("sha256").update(`${instanceId}\0${name}`).digest("hex");
}

function order(instanceId: string, accounts: string[]): string[] {
  return accounts.toSorted((a, b) => {
    const left = rank(instanceId, a);
    const right = rank(instanceId, b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

const trio = ["alpha", "bravo", "charlie"];

function trioPool(): AccountPool {
  return new AccountPool(makeAccounts(...trio), null);
}

function utilization(value: string, reset?: string, bucket = "5h"): string[] {
  return [
    `anthropic-ratelimit-unified-${bucket}-utilization`,
    value,
    ...(reset === undefined
      ? []
      : [`anthropic-ratelimit-unified-${bucket}-reset`, reset]),
  ];
}

function epoch(milliseconds: number): string {
  return String(milliseconds / second);
}

const vms = Array.from({ length: 40 }, (_, index) => `vm-${String(index)}`);

test("the order of accounts is the hash order for each VM, stable for one VM and different between VMs", () => {
  const pool = trioPool();
  const chosen = new Set<string>();
  for (const vm of vms) {
    const first = pool.choose(vm, start).name;
    assert.equal(first, order(vm, trio)[0], vm);
    assert.equal(pool.choose(vm, start + day).name, first);
    assert.equal(
      new AccountPool(makeAccounts(...trio.toReversed()), null).choose(
        vm,
        start,
      ).name,
      first,
    );
    chosen.add(first);
  }
  assert.equal(chosen.size, 3);
});

test("choose returns the account with its token, and never reads the clock", () => {
  const clock = spyOn(Date, "now");
  onTestFinished(() => {
    clock.mockRestore();
  });
  const pool = trioPool();
  const account = pool.choose("vm-1", start);
  assert.deepEqual(account, {
    name: account.name,
    token: tokenOf(account.name),
  });
  pool.observe(account.name, 200, utilization("0.1"), start);
  pool.snapshot(start);
  assert.equal(clock.mock.calls.length, 0);
});

test("a VM leaves an account at 0.9 and returns when the bucket's reset has passed", () => {
  const pool = trioPool();
  const vm = vms[0] ?? "";
  const [first, second_] = order(vm, trio);
  assert.ok(first && second_);
  pool.observe(first, 200, utilization("0.95", epoch(start + 2 * hour)), start);
  assert.equal(pool.choose(vm, start).name, second_);
  assert.equal(pool.choose(vm, start + 2 * hour - 1).name, second_);
  assert.equal(pool.choose(vm, start + 2 * hour).name, first);
  assert.equal(pool.choose(vm, start + 3 * hour).name, first);
});

test("the threshold is 0.9 inclusive, on any bucket, and every bucket is tracked", () => {
  for (const [value, leaves] of [
    ["0.89", false],
    ["0.8999", false],
    ["0.9", true],
    ["0.90", true],
    ["1", true],
    ["1.7", true],
    ["9e-1", true],
    ["0", false],
  ] as const) {
    for (const bucket of ["5h", "7d", "7d_opus", "overage"]) {
      const pool = trioPool();
      const vm = "vm-7";
      const first = order(vm, trio)[0] ?? "";
      pool.observe(first, 200, utilization(value, undefined, bucket), start);
      assert.equal(
        pool.choose(vm, start).name !== first,
        leaves,
        `${value} ${bucket}`,
      );
    }
  }
  const pool = trioPool();
  const first = order("vm-7", trio)[0] ?? "";
  pool.observe(
    first,
    200,
    [...utilization("0.1"), ...utilization("0.99", undefined, "7d")],
    start,
  );
  assert.notEqual(pool.choose("vm-7", start).name, first);
});

test("a later report replaces an earlier one for the same bucket, and an account can come back sooner than it left", () => {
  const pool = trioPool();
  const first = order("vm-7", trio)[0] ?? "";
  pool.observe(first, 200, utilization("0.95", epoch(start + hour)), start);
  assert.notEqual(pool.choose("vm-7", start).name, first);
  pool.observe(
    first,
    200,
    utilization("0.2", epoch(start + hour)),
    start + 10 * second,
  );
  assert.equal(pool.choose("vm-7", start + 10 * second).name, first);
});

test("a bucket without a usable reset lasts one hour", () => {
  const first = order("vm-7", trio)[0] ?? "";
  const cases: [string, string | undefined][] = [
    ["absent", undefined],
    ["in the past", epoch(start - hour)],
    ["now", epoch(start)],
    ["more than eight days ahead", epoch(start + 8 * day + second)],
    ["absurdly far", "99999999999999"],
    ["not a number", "soon"],
    ["fractional", "1800003600.5"],
    ["exponent", "1.8e9"],
    ["negative", "-1800003600"],
    ["zero", "0"],
    ["empty", ""],
    ["hex", "0x6b49d200"],
    ["with a space", " 1800003600"],
  ];
  for (const [name, reset] of cases) {
    const pool = trioPool();
    pool.observe(first, 200, utilization("0.95", reset), start);
    const row = pool.snapshot(start).find((entry) => entry.name === first);
    assert.deepEqual(
      row?.buckets,
      [{ bucket: "5h", utilization: 0.95, expires: start + hour }],
      name,
    );
  }
});

test("a reset up to eight days ahead is believed", () => {
  const first = order("vm-7", trio)[0] ?? "";
  const pool = trioPool();
  pool.observe(first, 200, utilization("0.95", epoch(start + 8 * day)), start);
  assert.equal(
    pool.snapshot(start).find(({ name }) => name === first)?.buckets[0]
      ?.expires,
    start + 8 * day,
  );
  assert.notEqual(pool.choose("vm-7", start + 8 * day - 1).name, first);
  assert.equal(pool.choose("vm-7", start + 8 * day).name, first);
  const sooner = trioPool();
  sooner.observe(first, 200, utilization("0.95", epoch(start + second)), start);
  assert.equal(sooner.choose("vm-7", start + second).name, first);
});

test("a utilization that is not a finite number is ignored", () => {
  const first = order("vm-7", trio)[0] ?? "";
  for (const value of [
    "",
    " ",
    "high",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e999",
    "0x1",
    "1,5",
    "0.95x",
    "--1",
  ]) {
    const pool = trioPool();
    pool.observe(first, 200, utilization(value), start);
    assert.deepEqual(
      pool.snapshot(start).find(({ name }) => name === first)?.buckets,
      [],
      JSON.stringify(value),
    );
    assert.equal(pool.choose("vm-7", start).name, first);
  }
});

test("only headers that fit the bucket pattern count, in any case of name, and the first line of a name wins", () => {
  const first = order("vm-7", trio)[0] ?? "";
  const pool = trioPool();
  pool.observe(
    first,
    200,
    [
      "anthropic-ratelimit-unified-status",
      "0.99",
      "anthropic-ratelimit-unified-utilization",
      "0.99",
      "anthropic-ratelimit-unified--utilization",
      "0.99",
      "anthropic-ratelimit-unified-5h.x-utilization",
      "0.99",
      "x-anthropic-ratelimit-unified-5h-utilization",
      "0.99",
      "anthropic-ratelimit-unified-5h-utilization-extra",
      "0.99",
    ],
    start,
  );
  assert.deepEqual(
    pool.snapshot(start).find(({ name }) => name === first)?.buckets,
    [],
  );
  pool.observe(
    first,
    200,
    [
      "Anthropic-RateLimit-Unified-7D-Utilization",
      "0.95",
      "ANTHROPIC-RATELIMIT-UNIFIED-7D-RESET",
      epoch(start + hour),
      "anthropic-ratelimit-unified-7d-reset",
      epoch(start + 2 * hour),
    ],
    start,
  );
  assert.deepEqual(
    pool.snapshot(start).find(({ name }) => name === first)?.buckets,
    [{ bucket: "7d", utilization: 0.95, expires: start + hour }],
  );
});

test("a rejected 429 holds the account until the reset, and the VM returns after it", () => {
  const pool = trioPool();
  const [first, next] = order("vm-7", trio);
  assert.ok(first && next);
  pool.observe(
    first,
    429,
    [
      "anthropic-ratelimit-unified-status",
      "rejected",
      "anthropic-ratelimit-unified-reset",
      epoch(start + 3 * hour),
    ],
    start,
  );
  assert.equal(pool.choose("vm-7", start).name, next);
  assert.equal(pool.choose("vm-7", start + 3 * hour - 1).name, next);
  assert.equal(pool.choose("vm-7", start + 3 * hour).name, first);
  assert.deepEqual(
    pool.snapshot(start).find(({ name }) => name === first)?.held,
    true,
  );
  assert.equal(
    pool.snapshot(start).find(({ name }) => name === first)?.heldUntil,
    start + 3 * hour,
  );
  assert.equal(
    pool.snapshot(start + 3 * hour).find(({ name }) => name === first)?.held,
    false,
  );
});

test("a 2xx for a request that was sent before a hold began does not release it, and one sent after does", () => {
  const rejected = [
    "anthropic-ratelimit-unified-status",
    "rejected",
    "anthropic-ratelimit-unified-reset",
    epoch(start + 3 * hour),
  ];
  captureStderr();
  for (const hold of [
    (pool: AccountPool, name: string) => {
      pool.observe(name, 429, rejected, start + 5 * second);
    },
    (pool: AccountPool, name: string) => {
      pool.observe(name, 401, [], start + 5 * second);
    },
  ]) {
    const pool = trioPool();
    const [first, next] = order("vm-7", trio);
    assert.ok(first && next);
    hold(pool, first);
    pool.observe(first, 200, [], start + 6 * second, start);
    assert.equal(pool.choose("vm-7", start + 6 * second).name, next);
    pool.observe(first, 200, [], start + 7 * second, start + 5 * second);
    assert.equal(pool.choose("vm-7", start + 7 * second).name, first);
  }
});

test("a rejected 429 whose reset is unusable holds for five minutes", () => {
  const first = order("vm-7", trio)[0] ?? "";
  for (const reset of [
    undefined,
    epoch(start - hour),
    epoch(start),
    epoch(start + 8 * day + second),
    "99999999999999",
    "soon",
    "",
    "-5",
    "1.5",
    "0",
  ]) {
    const pool = trioPool();
    pool.observe(
      first,
      429,
      [
        "anthropic-ratelimit-unified-status",
        "rejected",
        ...(reset === undefined
          ? []
          : ["anthropic-ratelimit-unified-reset", reset]),
      ],
      start,
    );
    assert.notEqual(
      pool.choose("vm-7", start + 5 * 60 * second - 1).name,
      first,
      String(reset),
    );
    assert.equal(
      pool.choose("vm-7", start + 5 * 60 * second).name,
      first,
      String(reset),
    );
  }
});

test("a rejected 429 without a usable reset does not shorten a longer hold", () => {
  const pool = trioPool();
  const [first, next] = order("vm-7", trio);
  assert.ok(first && next);
  pool.observe(
    first,
    429,
    [
      "anthropic-ratelimit-unified-status",
      "rejected",
      "anthropic-ratelimit-unified-reset",
      epoch(start + 3 * day),
    ],
    start,
  );
  pool.observe(
    first,
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start + second,
  );
  assert.equal(
    pool.snapshot(start + second).find(({ name }) => name === first)?.heldUntil,
    start + 3 * day,
  );
  assert.equal(pool.choose("vm-7", start + hour).name, next);
});

test("a 429 that is not a rejection holds nothing", () => {
  const first = order("vm-7", trio)[0] ?? "";
  for (const status of [
    [],
    ["anthropic-ratelimit-unified-status", "allowed"],
    ["anthropic-ratelimit-unified-status", "allowed_warning"],
    ["anthropic-ratelimit-unified-status", "Rejected"],
    ["anthropic-ratelimit-unified-status", "rejected "],
  ]) {
    const pool = trioPool();
    pool.observe(
      first,
      429,
      [...status, "anthropic-ratelimit-unified-reset", epoch(start + hour)],
      start,
    );
    assert.equal(pool.choose("vm-7", start).name, first, status.join("="));
  }
  const rejected = trioPool();
  rejected.observe(
    first,
    200,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  rejected.observe(
    first,
    500,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.equal(rejected.choose("vm-7", start).name, first);
});

test("a 401 holds the account for ten minutes and writes one line that names the account and nothing secret", () => {
  const lines = captureStderr();
  const pool = trioPool();
  const first = order("vm-7", trio)[0] ?? "";
  pool.observe(first, 401, ["x-secret", tokenOf(first)], start);
  assert.deepEqual(lines, [
    `cog: the provider refused Claude pool account ${first} (401)\n`,
  ]);
  assert.notEqual(
    pool.choose("vm-7", start + 10 * 60 * second - 1).name,
    first,
  );
  assert.equal(pool.choose("vm-7", start + 10 * 60 * second).name, first);
  pool.observe(first, 200, [], start + 10 * 60 * second);
  assert.equal(lines.length, 1);
  assert.ok(!lines.join("").includes(marker));
});

test("a 401 on a held account does not shorten the hold or write another line", () => {
  const lines = captureStderr();
  const pool = trioPool();
  const first = order("vm-7", trio)[0] ?? "";
  pool.observe(
    first,
    429,
    [
      "anthropic-ratelimit-unified-status",
      "rejected",
      "anthropic-ratelimit-unified-reset",
      epoch(start + 3 * hour),
    ],
    start,
  );
  pool.observe(first, 401, [], start + second);
  assert.deepEqual(lines, []);
  assert.notEqual(pool.choose("vm-7", start + 3 * hour - 1).name, first);
  assert.equal(pool.choose("vm-7", start + 3 * hour).name, first);
  const again = trioPool();
  again.observe(first, 401, [], start);
  again.observe(first, 401, [], start + 9 * 60 * second);
  assert.equal(lines.length, 1);
  assert.notEqual(
    again.choose("vm-7", start + 19 * 60 * second - 1).name,
    first,
  );
  assert.equal(again.choose("vm-7", start + 19 * 60 * second).name, first);
});

test("a 2xx clears a hold, a 403 changes nothing, and other statuses leave a hold alone", () => {
  captureStderr();
  const first = order("vm-7", trio)[0] ?? "";
  for (const status of [200, 201, 204, 299]) {
    const pool = trioPool();
    pool.observe(first, 401, [], start);
    assert.notEqual(pool.choose("vm-7", start).name, first);
    pool.observe(first, status, [], start + second);
    assert.equal(
      pool.choose("vm-7", start + second).name,
      first,
      String(status),
    );
  }
  for (const status of [300, 400, 404, 500, 529]) {
    const pool = trioPool();
    pool.observe(first, 401, [], start);
    pool.observe(first, status, [], start + second);
    assert.notEqual(
      pool.choose("vm-7", start + second).name,
      first,
      String(status),
    );
  }
  const forbidden = trioPool();
  forbidden.observe(first, 403, [], start);
  forbidden.observe(first, 403, utilization("0.99"), start);
  forbidden.observe(
    first,
    403,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.equal(forbidden.choose("vm-7", start).name, first);
  assert.deepEqual(
    forbidden.snapshot(start).find(({ name }) => name === first),
    {
      name: first,
      held: false,
      heldUntil: null,
      buckets: [],
    },
  );
  const held = trioPool();
  held.observe(
    first,
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  held.observe(first, 403, [], start + second);
  assert.notEqual(held.choose("vm-7", start + second).name, first);
});

test("when every account is near its limit the first in the order is not held is chosen, and when every account is held the first in the order", () => {
  const pool = trioPool();
  const ranked = order("vm-7", trio);
  for (const name of trio) {
    pool.observe(name, 200, utilization("0.95", epoch(start + hour)), start);
  }
  assert.equal(pool.choose("vm-7", start).name, ranked[0]);
  pool.observe(
    ranked[0] ?? "",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.equal(pool.choose("vm-7", start).name, ranked[1]);
  pool.observe(
    ranked[1] ?? "",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.equal(pool.choose("vm-7", start).name, ranked[2]);
  pool.observe(
    ranked[2] ?? "",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.equal(pool.choose("vm-7", start).name, ranked[0]);
  assert.equal(pool.choose("vm-8", start).name, order("vm-8", trio)[0]);
});

test("a held account is passed over for one that is near, and a near one for one that is free", () => {
  const pool = trioPool();
  const [a, b, c] = order("vm-7", trio);
  assert.ok(a && b && c);
  pool.observe(
    a,
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  pool.observe(b, 200, utilization("0.95"), start);
  assert.equal(pool.choose("vm-7", start).name, c);
  pool.observe(c, 200, utilization("0.95"), start);
  assert.equal(pool.choose("vm-7", start).name, b);
});

test("a single-account pool always returns its account, and an empty one has none to return", () => {
  const pool = new AccountPool(makeAccounts("only"), null);
  pool.observe(
    "only",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  pool.observe("only", 200, utilization("1"), start);
  assert.equal(pool.choose("vm-1", start).name, "only");
  assert.throws(() => new AccountPool([], null).choose("vm-1", start), {
    message: "the pool has no account",
  });
});

test("a reload keeps the state of an account whose name and token are unchanged and forgets the rest", () => {
  captureStderr();
  const before = new AccountPool(
    makeAccounts("alpha", "bravo", "charlie", "delta"),
    null,
  );
  before.observe(
    "alpha",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  before.observe("bravo", 200, utilization("0.95", epoch(start + hour)), start);
  before.observe("charlie", 401, [], start);
  before.observe("delta", 200, utilization("0.95", epoch(start + hour)), start);
  const after = new AccountPool(
    [
      { name: "alpha", token: tokenOf("alpha") },
      { name: "bravo", token: "sk-ant-oat01-rotated" },
      { name: "charlie", token: tokenOf("charlie") },
      { name: "echo", token: tokenOf("echo") },
    ],
    before,
  );
  const state = new Map(
    after.snapshot(start).map((row) => [row.name, row] as const),
  );
  assert.equal(state.get("alpha")?.held, true);
  assert.equal(state.get("bravo")?.held, false);
  assert.deepEqual(state.get("bravo")?.buckets, []);
  assert.equal(state.get("charlie")?.held, true);
  assert.deepEqual(state.get("echo"), {
    name: "echo",
    held: false,
    heldUntil: null,
    buckets: [],
  });
  assert.equal(state.has("delta"), false);
  const again = new AccountPool(makeAccounts("delta"), after);
  assert.deepEqual(again.snapshot(start)[0]?.buckets, []);
});

test("an observation of a name that is not in the pool is ignored", () => {
  const lines = captureStderr();
  const pool = trioPool();
  const before = JSON.stringify(pool.snapshot(start));
  pool.observe("gone", 401, [], start);
  pool.observe("gone", 200, utilization("0.99"), start);
  pool.observe(
    "toString",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  pool.observe("__proto__", 401, [], start);
  assert.equal(JSON.stringify(pool.snapshot(start)), before);
  assert.deepEqual(lines, []);
});

test("an observation made after a reload of an account that is gone is ignored", () => {
  const before = trioPool();
  const after = new AccountPool(makeAccounts("alpha"), before);
  after.observe(
    "bravo",
    429,
    ["anthropic-ratelimit-unified-status", "rejected"],
    start,
  );
  assert.deepEqual(
    after.snapshot(start).map(({ name }) => name),
    ["alpha"],
  );
});

test("a snapshot lists each account with its hold and its unexpired buckets, and never a token", () => {
  captureStderr();
  const pool = trioPool();
  pool.observe(
    "alpha",
    429,
    [
      "anthropic-ratelimit-unified-status",
      "rejected",
      "anthropic-ratelimit-unified-reset",
      epoch(start + hour),
    ],
    start,
  );
  pool.observe(
    "bravo",
    200,
    [
      ...utilization("0.5", epoch(start + hour)),
      ...utilization("0.7", epoch(start + 2 * hour), "7d"),
    ],
    start,
  );
  pool.observe("charlie", 401, [], start);
  assert.deepEqual(pool.snapshot(start + second), [
    {
      name: "alpha",
      held: true,
      heldUntil: start + hour,
      buckets: [],
    },
    {
      name: "bravo",
      held: false,
      heldUntil: null,
      buckets: [
        { bucket: "5h", utilization: 0.5, expires: start + hour },
        { bucket: "7d", utilization: 0.7, expires: start + 2 * hour },
      ],
    },
    {
      name: "charlie",
      held: true,
      heldUntil: start + 10 * 60 * second,
      buckets: [],
    },
  ]);
  const now = start + hour + second;
  assert.deepEqual(pool.snapshot(now), [
    { name: "alpha", held: false, heldUntil: null, buckets: [] },
    {
      name: "bravo",
      held: false,
      heldUntil: null,
      buckets: [{ bucket: "7d", utilization: 0.7, expires: start + 2 * hour }],
    },
    { name: "charlie", held: false, heldUntil: null, buckets: [] },
  ]);
  for (const at of [start, now, start + day]) {
    const text = JSON.stringify(pool.snapshot(at));
    assert.ok(!text.includes(marker));
    assert.ok(!text.includes("sk-ant"));
  }
});
