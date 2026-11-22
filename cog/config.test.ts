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
import { test } from "bun:test";
import { loadConfig } from "./config.ts";
import { CogError, CommandFailed, exitStatus, Interrupted } from "./errors.ts";

test("the defaults come from HOME alone", () => {
  assert.deepEqual(loadConfig({ HOME: "/h" }), {
    home: "/h",
    base: "cog-base",
    cpus: "",
    memory: "",
    githubWebUrl: "https://github.com",
    promptInput: "",
    tailscaleFile: "/h/.config/secrets/cog/tailscale-oauth.json",
    claudeTokenFile: "/h/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN",
    fireworksKeyFile: "/h/.config/secrets/FIREWORKS_API_KEY",
    codexAuthFile: "/h/.codex/auth.json",
    defaultDotfiles: "/h/src/github.com/shields/dotfiles",
  });
});

test("the COG variables replace the defaults and an empty one counts as unset", () => {
  const config = loadConfig({
    HOME: "/h",
    COG_BASE: "other-base",
    COG_CPUS: "4",
    COG_MEMORY: "8",
    COG_GITHUB_WEB_URL: "https://git.example.com",
    COG_PROMPT_INPUT: "/p",
  });
  assert.equal(config.base, "other-base");
  assert.equal(config.cpus, "4");
  assert.equal(config.memory, "8");
  assert.equal(config.githubWebUrl, "https://git.example.com");
  assert.equal(config.promptInput, "/p");
  const empty = loadConfig({
    HOME: "/h",
    COG_BASE: "",
    COG_GITHUB_WEB_URL: "",
    COG_CPUS: "",
  });
  assert.equal(empty.base, "cog-base");
  assert.equal(empty.githubWebUrl, "https://github.com");
  assert.equal(empty.cpus, "");
});

test("a missing or empty HOME is an error", () => {
  for (const env of [{}, { HOME: "" }]) {
    assert.throws(
      () => loadConfig(env),
      (error: unknown) =>
        error instanceof CogError && error.message === "HOME is not set",
    );
  }
});

test("the exit status is the child's, the signal's, or 1", () => {
  assert.equal(exitStatus(new CogError("x")), 1);
  assert.equal(exitStatus(new Error("x")), 1);
  assert.equal(exitStatus(new CommandFailed("limactl start", 7)), 7);
  assert.equal(exitStatus(new Interrupted(143)), 143);
  assert.equal(
    new CommandFailed("limactl start", 7).message,
    "limactl start failed with status 7",
  );
});
