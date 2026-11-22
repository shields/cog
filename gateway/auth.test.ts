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
import { createServer } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, mock, spyOn, test } from "bun:test";
import { AppAuth } from "./auth.ts";

afterEach(() => {
  mock.restore();
});

test("device flow requests one repository and checks the resulting token", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-device-"));
  const gh = path.join(directory, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '4242\\n'\n");
  chmodSync(gh, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  let verifiedId = 4242;
  const requests: {
    pathname: string;
    repositoryId: string | null;
    authorization: string | null;
  }[] = [];
  const request = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    const form =
      init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const headers = new Headers(init?.headers);
    requests.push({
      pathname: url.pathname,
      repositoryId: form.get("repository_id"),
      authorization: headers.get("authorization"),
    });
    const payload =
      url.pathname === "/login/device/code"
        ? {
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 0,
          }
        : url.pathname === "/login/oauth/access_token"
          ? {
              access_token: "ghu_scoped",
              expires_in: 3600,
              refresh_token: "ghr_scoped",
              refresh_token_expires_in: 86_400,
            }
          : { id: verifiedId, full_name: "shields/dotfiles" };
    return Promise.resolve(Response.json(payload));
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(request, { preconnect: fetch.preconnect }),
  );
  try {
    const auth = new AppAuth(path.join(directory, "secrets"));
    const issued = await auth.issue("shields/dotfiles");
    assert.equal(issued.access_token, "ghu_scoped");
    assert.equal(auth.has("shields/dotfiles"), false);
    requests.length = 0;
    await auth.authorize("shields/dotfiles");
    assert.equal(auth.load("shields/dotfiles").access_token, "ghu_scoped");
    assert.deepEqual(
      requests.map((request) => request.pathname),
      [
        "/login/device/code",
        "/login/oauth/access_token",
        "/repos/shields/dotfiles",
      ],
    );
    assert.equal(requests[1]?.repositoryId, "4242");
    assert.equal(requests[2]?.authorization, "Bearer ghu_scoped");
    verifiedId = 77;
    await assert.rejects(
      auth.authorize("shields/dotfiles"),
      /wrong repository/,
    );
    assert.equal(auth.load("shields/dotfiles").access_token, "ghu_scoped");
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("device flow names gh when it cannot be run", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-no-gh-"));
  const originalPath = process.env.PATH;
  process.env.PATH = directory;
  const fetched = spyOn(globalThis, "fetch");
  try {
    const auth = new AppAuth(path.join(directory, "secrets"));
    await assert.rejects(
      auth.issue("shields/dotfiles"),
      /cannot run gh to read shields\/dotfiles/,
    );
    assert.equal(fetched.mock.calls.length, 0);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent callers spend one refresh token and persist its replacement", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-auth-"));
  let refreshes = 0;
  const upstream = createServer((request, response) => {
    refreshes++;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      assert.equal(
        new URLSearchParams(Buffer.concat(chunks).toString()).get(
          "refresh_token",
        ),
        "ghr_old",
      );
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "ghu_new",
            expires_in: 3600,
            refresh_token: "ghr_new",
            refresh_token_expires_in: 86_400,
          }),
        );
      }, 40);
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const repository = "shields/dotfiles";
  const file = path.join(
    directory,
    `${Buffer.from(repository).toString("base64url")}.json`,
  );
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    file,
    JSON.stringify({
      client_id: "Iv-test",
      repository,
      access_token: "ghu_old",
      access_expires_at: now + 1,
      refresh_token: "ghr_old",
      refresh_expires_at: now + 86_400,
      web_url: `http://127.0.0.1:${String(address.port)}`,
      api_url: "https://api.github.com",
    }),
  );
  try {
    const first = new AppAuth(directory);
    const second = new AppAuth(directory);
    assert.deepEqual(
      await Promise.all([first.token(repository), second.token(repository)]),
      ["ghu_new", "ghu_new"],
    );
    assert.equal(refreshes, 1);
    assert.equal(first.load(repository).refresh_token, "ghr_new");
  } finally {
    await new Promise<void>((resolve) => {
      upstream.close(() => {
        resolve();
      });
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a record that is not JSON is reported without quoting it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-corrupt-"));
  try {
    const auth = new AppAuth(directory);
    for (const contents of ["ghr_leaked", '{"refresh_token":"ghr_leaked"']) {
      writeFileSync(
        path.join(
          directory,
          `${Buffer.from("shields/dotfiles").toString("base64url")}.json`,
        ),
        contents,
      );
      assert.throws(
        () => auth.load("shields/dotfiles"),
        (error: unknown) =>
          error instanceof Error &&
          String(error) ===
            "Error: invalid authorization record for shields/dotfiles" &&
          !inspect(error).includes("ghr_leaked"),
        contents,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a record that cannot be read reports the read error, not an invalid record", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cog-unreadable-"));
  try {
    const auth = new AppAuth(directory);
    mkdirSync(
      path.join(
        directory,
        `${Buffer.from("shields/dotfiles").toString("base64url")}.json`,
      ),
    );
    assert.throws(() => auth.load("shields/dotfiles"), { code: "EISDIR" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
