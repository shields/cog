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

// Reads and prepares the gateway's state under $COG_ROOT for tests/test_cog.zsh:
//
//   dump                         the instances, grants and policy events as JSON
//   register lima:NAME SOCKET    registers a VM without telling the daemon
//   seed-auth OWNER/REPO...      stores fake GitHub App authorizations
//   seed-expired OWNER/REPO...   stores fake ones whose tokens have expired

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeRepository } from "../gateway/policy.ts";
import { State } from "../gateway/state.ts";

const FAKE_ACCESS = "ghu_fake-access";
const FAKE_REFRESH = "ghr_fake-refresh";
const CLIENT_ID = "Iv23lim5x4MdkNNgv28z";
const YEAR = 365 * 86_400;

function directories(): { state: string; secrets: string } {
  const root = process.env.COG_ROOT;
  if (!root) {
    throw new Error("COG_ROOT is not set");
  }
  return {
    state: path.join(root, "state"),
    secrets: path.join(root, "secrets"),
  };
}

function dump(state: State): void {
  const rows = state.db
    .prepare("SELECT id FROM instances ORDER BY created_at, rowid")
    .all() as unknown as { id: string }[];
  const instances = rows.map(({ id }) => {
    const instance = state.byId(id);
    if (!instance) {
      throw new Error("instance vanished");
    }
    return {
      name: instance.name,
      id: instance.id,
      socket: instance.socket,
      revision: instance.revision,
      disabled: instance.disabled,
      grants: state.grants(id),
      events: state
        .events(id, -1)
        .toSorted((left, right) => left.createdAt - right.createdAt)
        .map((event) => ({
          oldRevision: event.oldRevision,
          newRevision: event.newRevision,
          changes: event.changes,
        })),
    };
  });
  process.stdout.write(`${JSON.stringify({ instances }, null, 1)}\n`);
}

function seedAuth(
  secrets: string,
  repositories: string[],
  lifetime: number,
): void {
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  chmodSync(secrets, 0o700);
  const now = Math.floor(Date.now() / 1000);
  for (const input of repositories) {
    const repository = normalizeRepository(input);
    const record = {
      client_id: CLIENT_ID,
      repository,
      access_token: FAKE_ACCESS,
      access_expires_at: now + lifetime,
      refresh_token: FAKE_REFRESH,
      refresh_expires_at: now + lifetime,
      web_url: "https://github.com",
      api_url: "https://api.github.com",
    };
    const file = path.join(
      secrets,
      `${Buffer.from(repository).toString("base64url")}.json`,
    );
    const descriptor = openSync(file, "w", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(descriptor);
    }
  }
}

const [verb, ...args] = process.argv.slice(2);
const location = directories();
const state = new State(location.state);
try {
  switch (verb) {
    case "dump": {
      dump(state);
      break;
    }
    case "register": {
      const [name, socket] = args;
      if (args.length !== 2 || !name || !socket) {
        throw new Error("usage: gateway_state.ts register lima:NAME SOCKET");
      }
      state.register(name, socket, "test");
      break;
    }
    case "seed-auth": {
      seedAuth(location.secrets, args, YEAR);
      break;
    }
    case "seed-expired": {
      seedAuth(location.secrets, args, -YEAR);
      break;
    }
    default: {
      throw new Error(
        "usage: gateway_state.ts {dump|register|seed-auth|seed-expired}",
      );
    }
  }
} finally {
  state.close();
}
