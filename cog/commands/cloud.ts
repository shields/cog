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

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AppAuth } from "../../gateway/auth.ts";
import { parseProfiles, profileNamed } from "../../gateway/control.ts";
import { normalizeRepository, parseGrants } from "../../gateway/policy.ts";
import type { Config } from "../config.ts";
import { CogError } from "../errors.ts";
import { profilesYaml } from "../resources.ts";
import { writeSecretFile } from "../secrets.ts";

const usage = "usage: cog cloud";

function origin(address: string): string {
  const url = URL.parse(address);
  if (
    url?.protocol !== "https:" ||
    address !== address.trim() ||
    !/^https:\/\/[^/?#@\\\s]+\/?$/i.test(address)
  ) {
    throw new CogError("Cloudflare URL must be a bare HTTPS origin");
  }
  return url.origin;
}

function readConfigFile(file: string, message: string): string {
  try {
    if (statSync(file).isFile()) {
      return readFileSync(file, "utf8").trim();
    }
  } catch {
    throw new CogError(message);
  }
  throw new CogError(message);
}

const policyFailures = new Set([
  "invalid VM name",
  "VM is already registered",
  "VM access has been revoked",
  "request body is too large",
  "invalid GitHub authorization record",
  "GitHub token cannot read the requested repository",
]);

async function policyFailure(response: Response): Promise<string | undefined> {
  if (response.status !== 403) {
    return undefined;
  }
  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    return undefined;
  }
  if (
    !reply ||
    typeof reply !== "object" ||
    !("error" in reply) ||
    typeof reply.error !== "string"
  ) {
    return undefined;
  }
  if (reply.error === "policy changed while editing") {
    return "policy changed while editing; retry the command";
  }
  if (
    /^GitHub authorization for [\w.-]+\/[\w.-]+ is missing$/.test(reply.error)
  ) {
    return "a repository is missing GitHub authorization; run cog cloud authorize OWNER/REPO";
  }
  return policyFailures.has(reply.error) ? reply.error : undefined;
}

function cloudFetch(url: string, init: BunFetchRequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    verbose: false,
    tls: { ...init.tls, rejectUnauthorized: true },
  });
}

function connect(urlFile: string, tokenFile: string) {
  const endpoint = origin(
    readConfigFile(urlFile, "cannot read cloudflare-url; run cog cloud config"),
  );
  const token = readConfigFile(
    tokenFile,
    "cannot read Cloudflare admin token file",
  );
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new CogError("Cloudflare admin token file is invalid");
  }
  return async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await cloudFetch(`${endpoint}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CogError("Cloudflare request failed");
    }
    if (!response.ok) {
      const failure = await policyFailure(response);
      throw new CogError(
        failure ??
          `Cloudflare request failed with HTTP ${String(response.status)}`,
      );
    }
    if (response.status === 204) {
      return null;
    }
    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      throw new CogError("Cloudflare returned invalid JSON");
    }
    if (JSON.stringify(reply).includes(token)) {
      throw new CogError("Cloudflare returned the admin token");
    }
    return reply;
  };
}

function instanceRoute(id: string | undefined): string {
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
    throw new CogError("expected a VM UUID");
  }
  return `/instances/${id}`;
}

function currentPolicy(reply: unknown) {
  try {
    if (
      reply &&
      typeof reply === "object" &&
      "revision" in reply &&
      "grants" in reply
    ) {
      const { revision } = reply;
      if (
        typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision >= 0
      ) {
        return { revision, grants: parseGrants(reply.grants) };
      }
    }
  } catch {
    throw new CogError("Cloudflare returned an invalid VM policy");
  }
  throw new CogError("Cloudflare returned an invalid VM policy");
}

export async function cloudCommand(
  args: string[],
  config: Config,
): Promise<unknown> {
  const [action, first, second, option, profile] = args;
  const urlFile = path.join(config.home, ".config", "cog", "cloudflare-url");
  const secretDir = path.join(config.home, ".config", "secrets", "cog");
  const api = () =>
    connect(urlFile, path.join(secretDir, "cloudflare-admin-token"));
  switch (action) {
    case "config": {
      if (args.length !== 2 || !first) {
        throw new CogError(`${usage} config HTTPS-WORKER-URL`);
      }
      const url = origin(first);
      writeSecretFile(urlFile, Buffer.from(`${url}\n`));
      return { url };
    }
    case "authorize": {
      if (args.length !== 2 || !first) {
        throw new CogError(`${usage} authorize OWNER/REPO`);
      }
      const repository = normalizeRepository(first);
      const request = api();
      const auth = new AppAuth(
        path.join(secretDir, "cloudflare-authorization"),
      );
      let issued;
      try {
        issued = await auth.issue(repository, {
          hostname: "github.com",
          request: cloudFetch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        switch (message) {
          case `GitHub device code for ${repository} expired`:
            throw new CogError(
              "GitHub device code expired; run cog cloud authorize again",
            );
          case `GitHub App token cannot read ${repository}`:
          case `GitHub App token returned the wrong repository for ${repository}`:
            throw new CogError(
              "GitHub App authorization did not grant access to the requested repository",
            );
          case `gh cannot read ${repository}; check the repository and your Mac gh login`:
            throw new CogError(
              "gh cannot read the repository; check the repository and your Mac gh login",
            );
          default:
            throw new CogError("GitHub device authorization failed");
        }
      }
      await request("POST", "/authorizations", {
        repository,
        accessToken: issued.access_token,
        accessExpiresAt: issued.access_expires_at,
        refreshToken: issued.refresh_token,
        refreshExpiresAt: issued.refresh_expires_at,
      });
      return { authorized: repository };
    }
    case "new": {
      if (args.length !== 2 || !first) {
        throw new CogError(`${usage} new NAME`);
      }
      return await api()("POST", "/instances", { name: first });
    }
    case "list": {
      if (args.length !== 1) {
        throw new CogError(`${usage} list`);
      }
      return await api()("GET", "/instances");
    }
    case "grant":
    case "revoke": {
      if (action === "grant") {
        if (
          !second ||
          (args.length !== 3 &&
            !(
              args.length === 5 &&
              option === "--profile" &&
              (profile === "read" || profile === "cog")
            ))
        ) {
          throw new CogError(
            `${usage} grant VM-ID OWNER/REPO [--profile read|cog]`,
          );
        }
      } else if (args.length !== 3 || !second) {
        throw new CogError(`${usage} revoke VM-ID OWNER/REPO`);
      }
      const route = instanceRoute(first);
      const repository = normalizeRepository(second);
      const request = api();
      const current = currentPolicy(await request("GET", route));
      if (action === "revoke" && !Object.hasOwn(current.grants, repository)) {
        throw new CogError(`${repository} is not granted to this VM`);
      }
      const grants =
        action === "grant"
          ? {
              ...current.grants,
              [repository]: profileNamed(
                parseProfiles(profilesYaml),
                profile ?? "cog",
              ),
            }
          : Object.fromEntries(
              Object.entries(current.grants).filter(
                ([key]) => key !== repository,
              ),
            );
      return await request("PUT", `${route}/grants`, {
        revision: current.revision,
        grants,
      });
    }
    case "show":
    case "start":
    case "logs":
    case "events":
    case "rm": {
      if (args.length !== 2) {
        throw new CogError(`${usage} ${action} VM-ID`);
      }
      const route = instanceRoute(first);
      const request = api();
      if (action === "rm") {
        await request("DELETE", route);
        return { deleted: first };
      }
      if (action === "show") {
        return await request("GET", route);
      }
      return await request(
        action === "start" ? "POST" : "GET",
        `${route}/${action}`,
      );
    }
    default:
      throw new CogError(
        `${usage} config|authorize|new|list|show|start|logs|events|grant|revoke|rm`,
      );
  }
}
