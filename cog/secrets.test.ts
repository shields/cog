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
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, onTestFinished, spyOn, test } from "bun:test";
import { compareCodeUnits } from "../gateway/policy.ts";
import { CogError } from "./errors.ts";
import {
  promptClaudeToken,
  readCodexAuth,
  setOneWord,
  toBytes,
  writeSecretFile,
} from "./secrets.ts";

const marker = "COG_SECRET_MARKER";

function directory(): string {
  const result = mkdtempSync(path.join(os.tmpdir(), "cog-secrets-"));
  onTestFinished(() => {
    rmSync(result, { recursive: true, force: true });
  });
  return result;
}

function message(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof CogError, String(error));
    return error.message;
  }
  return assert.fail("expected a CogError");
}

async function rejection(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof CogError, String(error));
    return error.message;
  }
  return assert.fail("expected a CogError");
}

describe("setOneWord", () => {
  const empty = "EMPTY";
  const spaces = "SPACES";

  test.each([
    ["abc", "abc"],
    ["  abc  ", "abc"],
    ["\tabc\n", "abc"],
    ["abc\r", "abc"],
    ["a\rb\rc", "abc"],
    ["\v\fabc\v\f", "abc"],
    ["sk-ant_oat01-AbC.123=", "sk-ant_oat01-AbC.123="],
    ["\u{E9}\u{FF}\u{80}", "\u{E9}\u{FF}\u{80}"],
    ["a\u{A0}b", "a\u{A0}b"],
    ["a\u{85}b", "a\u{85}b"],
  ])("%j gives %j", (line, word) => {
    assert.equal(setOneWord(line, empty, spaces), word);
  });

  test.each(["", " ", "\t\n", "\r", "\r\r \r", "\v\f"])(
    "%j is empty",
    (line) => {
      assert.equal(
        message(() => setOneWord(line, empty, spaces)),
        empty,
      );
    },
  );

  test.each([
    "a b",
    "a\tb",
    "a\nb",
    "a\vb",
    "a\fb",
    " a b ",
    "a\r b",
    "a\n\nb",
  ])("%j has spaces in it", (line) => {
    assert.equal(
      message(() => setOneWord(line, empty, spaces)),
      spaces,
    );
  });

  test("a secret survives the round trip through bytes unchanged", () => {
    const bytes = Uint8Array.from([0x41, 0xe9, 0xff, 0x80, 0x00, 0x7f]);
    const word = setOneWord(
      Buffer.from(bytes).toString("latin1"),
      empty,
      spaces,
    );
    assert.deepEqual(toBytes(word), bytes);
  });
});

describe("the Codex login", () => {
  const login = (content: string | Uint8Array): string => {
    const dir = directory();
    const file = path.join(dir, "auth.json");
    writeFileSync(file, content);
    return message(() => readCodexAuth(file));
  };

  test("a JSON object is returned byte for byte", () => {
    const file = path.join(directory(), "auth.json");
    const bytes = Buffer.from(
      `{"tokens": {"access_token": "${marker}"}}\n`,
      "utf8",
    );
    writeFileSync(file, bytes);
    assert.deepEqual(Buffer.from(readCodexAuth(file)), bytes);
    writeFileSync(file, " {}  ");
    assert.equal(Buffer.from(readCodexAuth(file)).toString(), " {}  ");
  });

  test("anything that is not one JSON object is refused without quoting it", () => {
    for (const content of [
      `{"tokens": {"access_token": "${marker}"`,
      marker,
      `["${marker}"]`,
      `{"access_token": "${marker}"} {"again": "${marker}"}`,
      `{"access_token": "${marker}"} trailing`,
      `{'access_token': '${marker}'}`,
      `{"access_token": "${marker}",}`,
      `"${marker}"`,
      "null",
      "12",
      "true",
      Uint8Array.from([0x7b, 0xff, 0xfe]),
    ]) {
      const text = login(content);
      assert.match(
        text,
        / is not a JSON object; run codex login on this Mac again, or pass --no-codex$/,
      );
      assert.equal(text.includes(marker), false);
    }
  });

  test("the checks run in order: exists, regular, readable, not empty", () => {
    const dir = directory();
    const missing = path.join(dir, "missing");
    assert.match(
      message(() => readCodexAuth(missing)),
      /does not exist; Codex keeps its login in the OS credential store when cli_auth_credentials_store/,
    );
    const dangling = path.join(dir, "dangling");
    symlinkSync(missing, dangling);
    assert.match(
      message(() => readCodexAuth(dangling)),
      /does not exist;/,
    );
    assert.equal(
      message(() => readCodexAuth(dir)),
      `${dir} is not a regular file; remove it, or pass --no-codex`,
    );
    const empty = path.join(dir, "empty");
    writeFileSync(empty, "");
    assert.equal(
      message(() => readCodexAuth(empty)),
      `${empty} is empty; run codex login on this Mac again, or pass --no-codex`,
    );
  });

  test("an unreadable file says so", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const locked = path.join(directory(), "locked");
    writeFileSync(locked, "{}");
    chmodSync(locked, 0o000);
    assert.equal(
      message(() => readCodexAuth(locked)),
      `cannot read ${locked}; run codex login on this Mac again, or pass --no-codex`,
    );
  });
});

describe("the typed token", () => {
  const typed = (content: string): Promise<string> => {
    const file = path.join(directory(), "prompt");
    writeFileSync(file, content);
    return promptClaudeToken(file);
  };

  test("is the first line of COG_PROMPT_INPUT", async () => {
    assert.equal(await typed(`${marker}\n`), marker);
    assert.equal(await typed(marker), marker);
    assert.equal(await typed(`  ${marker}\r\nsecond\n`), marker);
  });

  test("two words are refused without quoting them", async () => {
    for (const content of [
      `${marker} other`,
      `other ${marker}`,
      `${marker}\tsecond`,
    ]) {
      const text = await rejection(() => typed(content));
      assert.equal(
        text,
        "the Claude token has spaces in it; paste only the token",
      );
    }
  });

  test("an empty line says what to do", async () => {
    const empty =
      "the Claude token is empty; run claude setup-token in another terminal and paste its output";
    assert.equal(await rejection(() => typed("\n")), empty);
    assert.equal(await rejection(() => typed("")), empty);
  });

  test("a directory reads as an empty line", async () => {
    assert.match(
      await rejection(() => promptClaudeToken(directory())),
      /the Claude token is empty/,
    );
  });

  test("an unreadable or missing file is refused", async () => {
    assert.equal(
      await rejection(() =>
        promptClaudeToken(path.join(directory(), "missing")),
      ),
      "cannot read COG_PROMPT_INPUT",
    );
  });
});

describe("writeSecretFile", () => {
  const withUmask = (mask: number, work: () => void): void => {
    const previous = process.umask(mask);
    try {
      work();
    } finally {
      process.umask(previous);
    }
  };

  test.each([0o000, 0o022, 0o077])(
    "writes mode 0600 in a 0700 directory under umask %o",
    (mask) => {
      const dir = path.join(directory(), "nested", "secrets");
      const file = path.join(dir, "TOKEN");
      withUmask(mask, () => {
        writeSecretFile(file, toBytes(`${marker}\n`));
      });
      assert.equal(readFileSync(file, "utf8"), `${marker}\n`);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(dir), ["TOKEN"]);
    },
  );

  test("replaces a file of another mode and tightens a loose directory", () => {
    const dir = directory();
    const file = path.join(dir, "TOKEN");
    writeFileSync(file, "old", { mode: 0o644 });
    chmodSync(dir, 0o755);
    withUmask(0o000, () => {
      writeSecretFile(file, toBytes("new"));
    });
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  test("writes bytes unchanged", () => {
    const file = path.join(directory(), "TOKEN");
    const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x0a]);
    writeSecretFile(file, bytes);
    assert.deepEqual(new Uint8Array(readFileSync(file)), bytes);
  });

  test("a close that fails after it released the descriptor leaves no temporary file and closes nothing twice", () => {
    const dir = directory();
    const file = path.join(dir, "TOKEN");
    const close = fs.closeSync;
    let closed = 0;
    const closing = spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      closed += 1;
      close(descriptor);
      if (closed === 1) {
        throw Object.assign(new Error(`disk ${marker}`), { code: "EIO" });
      }
    });
    onTestFinished(() => {
      closing.mockRestore();
    });
    assert.equal(
      message(() => {
        writeSecretFile(file, toBytes(marker));
      }),
      `cannot write ${file}`,
    );
    assert.equal(closed, 1);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("a failure leaves no temporary file, keeps the old one and quotes nothing", () => {
    const dir = directory();
    const file = path.join(dir, "TOKEN");
    writeFileSync(file, "old");
    const blocked = path.join(file, "inner", "TOKEN");
    assert.equal(
      message(() => {
        writeSecretFile(blocked, toBytes(marker));
      }),
      `cannot write ${blocked}`,
    );
    assert.equal(readFileSync(file, "utf8"), "old");
    assert.deepEqual(readdirSync(dir), ["TOKEN"]);

    const target = path.join(dir, "directory");
    mkdirSync(target);
    assert.equal(
      message(() => {
        writeSecretFile(target, toBytes(marker));
      }),
      `cannot write ${target}`,
    );
    assert.deepEqual(readdirSync(dir).toSorted(compareCodeUnits), [
      "TOKEN",
      "directory",
    ]);
    assert.equal(existsSync(path.join(target, marker)), false);
  });
});
