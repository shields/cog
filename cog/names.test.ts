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
import { describe, test } from "bun:test";
import { CogError } from "./errors.ts";
import {
  gatewayName,
  githubHost,
  normalizeOrigin,
  originRepository,
  sizeArgs,
  validName,
  validRepository,
} from "./names.ts";

function fails(work: () => unknown, message: string | RegExp): void {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof CogError);
    if (typeof message === "string") {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }
    return true;
  });
}

describe("validName", () => {
  test.each([
    "t1",
    "vm-261119-224518",
    "a.b_c-d",
    "A",
    "cog-base",
    "0123",
    "a1.2b",
  ])("accepts %s", (name) => {
    assert.equal(validName(name), name);
  });

  test.each([
    "",
    "-a",
    "a-",
    ".a",
    "a..b",
    "a--b",
    "a b",
    "a/b",
    "a:b",
    "lima:a",
    "a\n",
    "\na",
    "é",
    "aé",
    "a;b",
    "$(x)",
    "a\0b",
  ])("rejects %j", (name) => {
    fails(() => validName(name), `invalid VM name: ${name}`);
  });
});

describe("validRepository", () => {
  test.each([
    "shields/dotfiles",
    "Shields/Dot.files",
    "a/b",
    "a_b/c-d.e",
    "a/.github",
    "a./b",
    "a/b.",
    ".a/b",
    "a/..b",
  ])("accepts %s", (repository) => {
    assert.equal(validRepository(repository), repository);
  });

  test.each([
    "",
    "a",
    "a/",
    "/a",
    "a/b/c",
    "./a",
    "../a",
    "a/.",
    "a/..",
    "./.",
    "../..",
    "a b/c",
    "a/b c",
    "a/b\n",
    "a/é",
    "a/b?x",
    "a/b#x",
    "a:b/c",
  ])("rejects %j", (repository) => {
    fails(
      () => validRepository(repository),
      `invalid repository, expected OWNER/REPO: ${repository}`,
    );
  });
});

test("the gateway keeps a Lima VM under lima:NAME", () => {
  assert.equal(gatewayName("t1"), "lima:t1");
});

describe("githubHost", () => {
  test.each([
    ["https://github.com", "github.com"],
    ["https://GitHub.COM", "github.com"],
    ["https://github.com/", "github.com"],
    ["https://github.com:8443/x", "github.com"],
    ["https://user@github.com", "github.com"],
    ["https://user:pw@Example.com:1/x@y", "example.com"],
    ["http://127.0.0.1:9999", "127.0.0.1"],
    ["github.com", "github.com"],
    ["github.com/x", "github.com"],
  ])("%s is %s", (url, host) => {
    assert.equal(githubHost(url), host);
  });
});

describe("originRepository", () => {
  const web = "https://github.com";
  test.each([
    ["git@github.com:shields/dotfiles.git", "shields/dotfiles"],
    ["git@github.com:shields/dotfiles", "shields/dotfiles"],
    ["git@GitHub.com:shields/dotfiles.git", "shields/dotfiles"],
    ["git@github.com:/shields/dotfiles.git", "shields/dotfiles"],
    ["git@github.com:shields/dotfiles/", "shields/dotfiles"],
    ["git@github.com:shields/dotfiles.git/", "shields/dotfiles"],
    ["git@github.com:shields/dotfiles.git.git", "shields/dotfiles.git"],
    ["ssh://git@github.com/shields/dotfiles.git", "shields/dotfiles"],
    ["ssh://git@github.com:22/shields/dotfiles.git", "shields/dotfiles"],
    ["https://github.com/shields/dotfiles.git", "shields/dotfiles"],
    ["https://github.com/shields/dotfiles", "shields/dotfiles"],
    ["https://GITHUB.com:443/shields/dotfiles", "shields/dotfiles"],
    ["https://github.com//shields/dotfiles", "shields/dotfiles"],
    ["https://github.com/", ""],
    ["https://github.com/a/b/c.git", "a/b/c"],
  ])("%s names %j", (url, repository) => {
    assert.equal(originRepository(url, web), repository);
  });

  test.each([
    "https://gitlab.com/shields/dotfiles.git",
    "git@gitlab.com:shields/dotfiles.git",
    "ssh://git@gitlab.com/shields/dotfiles.git",
    "https://user@github.com/shields/dotfiles.git",
    "https://github.com",
    "http://github.com/shields/dotfiles",
    "ssh://github.com/shields/dotfiles",
    "git://github.com/shields/dotfiles",
    "ssh://other@github.com/shields/dotfiles",
    "/srv/git/dotfiles",
    "git@github.com",
    "",
  ])("%j names no repository", (url) => {
    assert.equal(originRepository(url, web), null);
  });

  test("the host is the one in the web URL", () => {
    const enterprise = "https://git.example.com:8443";
    assert.equal(
      originRepository("git@git.example.com:a/b.git", enterprise),
      "a/b",
    );
    assert.equal(originRepository("git@github.com:a/b.git", enterprise), null);
  });
});

describe("normalizeOrigin", () => {
  test.each([
    ["", ""],
    [
      "git@github.com:shields/dotfiles.git",
      "https://github.com/shields/dotfiles.git",
    ],
    [
      "ssh://git@github.com/shields/dotfiles.git",
      "https://github.com/shields/dotfiles.git",
    ],
    [
      "https://github.com/shields/dotfiles.git",
      "https://github.com/shields/dotfiles.git",
    ],
    ["git@example.com:a/b.git", "git@example.com:a/b.git"],
    ["/srv/git/dotfiles.git", "/srv/git/dotfiles.git"],
    ["https://example.com/a@b", "https://example.com/a@b"],
  ])("%j becomes %j", (origin, normalized) => {
    assert.equal(normalizeOrigin(origin), normalized);
  });

  const marker = "COG_ORIGIN_CREDENTIAL";
  test.each([
    `https://user:${marker}@github.com/shields/dotfiles.git`,
    `https://${marker}@github.com/shields/dotfiles.git`,
    `HTTPS://${marker}@github.com/shields/dotfiles.git`,
    `ssh://git:${marker}@github.com/shields/dotfiles.git`,
    `ssh://${marker}@github.com/shields/dotfiles.git`,
  ])("%s is refused as carrying credentials", (origin) => {
    fails(() => normalizeOrigin(origin), "origin must not contain credentials");
  });

  test.each([
    `https://github.com/shields/dotfiles.git?token=${marker}`,
    `https://github.com/shields/dotfiles.git#${marker}`,
    `git@github.com:shields/dotfiles.git?x=${marker}`,
    `/srv/git/${marker}#x`,
    "https://github.com/a\tb",
    "https://github.com/a\u{1B}b",
    "https://github.com/a\u{7F}b",
    "https://github.com/a\nb",
  ])("%j is refused", (origin) => {
    fails(
      () => normalizeOrigin(origin),
      "origin must not contain query parameters, fragments or control characters",
    );
  });

  test("a refusal never quotes the origin", () => {
    for (const origin of [
      `https://${marker}@github.com/x`,
      `https://github.com/x?${marker}`,
    ]) {
      try {
        normalizeOrigin(origin);
        assert.fail("expected a refusal");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(marker), false);
      }
    }
  });
});

describe("sizeArgs", () => {
  test("nothing is set", () => {
    assert.deepEqual(sizeArgs("", ""), []);
  });

  test("both are set", () => {
    assert.deepEqual(sizeArgs("4", "8"), ["--cpus", "4", "--memory", "8"]);
    assert.deepEqual(sizeArgs("16", ""), ["--cpus", "16"]);
    assert.deepEqual(sizeArgs("", "32"), ["--memory", "32"]);
  });

  test.each(["many", "0", "01", "-1", "1.5", " 1", "1 ", "4GiB", "１"])(
    "COG_CPUS=%j is refused",
    (value) => {
      fails(() => sizeArgs(value, ""), "COG_CPUS must be a whole number");
    },
  );

  test.each(["many", "0", "08", "8GiB", "8 GiB", "-8", "1e3"])(
    "COG_MEMORY=%j is refused",
    (value) => {
      fails(
        () => sizeArgs("", value),
        "COG_MEMORY must be a whole number of GiB",
      );
    },
  );

  test("cpus are checked before memory", () => {
    fails(() => sizeArgs("x", "y"), "COG_CPUS must be a whole number");
  });
});
