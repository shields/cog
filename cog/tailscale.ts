import { lstatSync, readFileSync } from "node:fs";
import type { State, TailscaleNode } from "../gateway/state.ts";
import type { Config } from "./config.ts";
import { CogError } from "./errors.ts";
import type { Lima } from "./lima.ts";
import { say } from "./output.ts";
import { signals } from "./proc.ts";
import { promptSecretLine, toBytes, writeSecretFile } from "./secrets.ts";

interface Credential {
  clientId: string;
  clientSecret: string;
}

const tag = "tag:cog";
const idPattern = /^[A-Za-z0-9_-]+$/;
const secretPattern = /^tskey-client-[A-Za-z0-9_-]+$/;

export async function configureTailscale(
  args: readonly string[],
  config: Config,
): Promise<void> {
  const [verb, clientId] = args;
  if (
    args.length !== 2 ||
    verb !== "config" ||
    !clientId ||
    !idPattern.test(clientId) ||
    clientId.startsWith("tskey-")
  ) {
    throw new CogError("usage: cog tailscale config CLIENT-ID");
  }
  const clientSecret = (
    await promptSecretLine(
      config.promptInput,
      "Tailscale OAuth client secret (no echo): ",
      "Tailscale OAuth client secret",
    )
  ).trim();
  if (!secretPattern.test(clientSecret)) {
    throw new CogError("invalid Tailscale OAuth client secret");
  }
  writeSecretFile(
    config.tailscaleFile,
    toBytes(JSON.stringify({ clientId, clientSecret }) + "\n"),
  );
  say("cog: new VMs will join Tailscale.");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CogError("invalid Tailscale response");
  }
  return value as Record<string, unknown>;
}

export function tailscaleCredential(file: string): Credential | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      return undefined;
    }
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error("invalid credential file");
    }
    const { clientId, clientSecret } = object(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (
      typeof clientId !== "string" ||
      !idPattern.test(clientId) ||
      typeof clientSecret !== "string" ||
      !secretPattern.test(clientSecret)
    ) {
      throw new Error("invalid credential file");
    }
    return { clientId, clientSecret };
  } catch {
    throw new CogError(
      "cannot read Tailscale credential; run cog tailscale config CLIENT-ID",
    );
  }
}

async function request(route: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.tailscale.com/api/v2/${route}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      verbose: false,
      tls: { rejectUnauthorized: true },
    });
  } catch {
    throw new CogError("Tailscale API request failed");
  }
  if (response.status === 404 && init.method === "DELETE") {
    return null;
  }
  if (!response.ok) {
    throw new CogError(
      `Tailscale API request failed with HTTP ${String(response.status)}`,
    );
  }
  if (init.method === "DELETE") {
    return null;
  }
  try {
    return await response.json();
  } catch {
    throw new CogError("invalid Tailscale API response");
  }
}

async function connect(credential: Credential) {
  const token = object(
    await request("oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        grant_type: "client_credentials",
      }),
    }),
  ).access_token;
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new CogError("invalid Tailscale OAuth response");
  }
  return (route: string, method: string, body?: unknown) =>
    request(route, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

// The UUID hostname identifies an interrupted enrollment until the node ID is saved.
const bootstrapName = (instanceId: string): string => `cog-${instanceId}`;

function taggedDevice(value: unknown, hostname: string): boolean {
  const device = object(value);
  return (
    device.hostname === hostname &&
    Array.isArray(device.tags) &&
    device.tags.includes(tag)
  );
}

async function enrollingNode(
  api: Awaited<ReturnType<typeof connect>>,
  instanceId: string,
): Promise<string | null> {
  const hostname = bootstrapName(instanceId);
  const query = new URLSearchParams({ hostname, tags: tag });
  const { devices } = object(
    await api(`tailnet/-/devices?${query.toString()}`, "GET"),
  );
  if (!Array.isArray(devices)) {
    throw new CogError("invalid Tailscale device list");
  }
  const matches = devices.filter((device: unknown) =>
    taggedDevice(device, hostname),
  );
  if (matches.length === 0) return null;
  const nodeId = object(matches[0]).nodeId;
  if (
    matches.length !== 1 ||
    typeof nodeId !== "string" ||
    !idPattern.test(nodeId)
  ) {
    throw new CogError("cannot identify the enrolled Tailscale device");
  }
  return nodeId;
}

async function waitForDevice(
  read: () => Promise<string | null>,
  message: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  do {
    signals.check();
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(500);
  } while (Date.now() < deadline);
  throw new CogError(message);
}

export async function enrollTailscale(
  lima: Pick<Lima, "shell" | "shellOutput">,
  state: State,
  credential: Credential,
  name: string,
  instanceId: string,
): Promise<string> {
  try {
    await lima.shell(name, [
      "sudo",
      "sh",
      "-ec",
      'test -x /usr/bin/tailscale && test ! -e /var/lib/tailscale/tailscaled.state && test "$(systemctl is-enabled tailscaled.service)" = masked && nft list chain inet lima_isolation input >/dev/null',
    ]);
  } catch {
    signals.check();
    throw new CogError(
      "the base is not ready for Tailscale; rebuild it with cog base",
    );
  }
  await lima.shell(name, ["sudo", "systemctl", "unmask", "tailscaled.service"]);
  await lima.shell(name, [
    "sudo",
    "systemctl",
    "enable",
    "--now",
    "tailscaled.service",
  ]);
  const api = await connect(credential);
  const { id, key } = object(
    await api("tailnet/-/keys", "POST", {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: false,
            tags: [tag],
          },
        },
      },
      expirySeconds: 600,
      description: `cog-${instanceId}`,
    }),
  );
  if (
    typeof id !== "string" ||
    !idPattern.test(id) ||
    typeof key !== "string" ||
    !/^tskey-auth-[A-Za-z0-9_-]+$/.test(key)
  ) {
    throw new CogError("invalid Tailscale auth key response");
  }
  try {
    state.beginTailscale(instanceId, id);
  } catch (error) {
    await api(`tailnet/-/keys/${id}`, "DELETE");
    throw error;
  }
  const initial = bootstrapName(instanceId);
  await lima.shell(
    name,
    [
      "sudo",
      "tailscale",
      "up",
      "--ssh",
      "--accept-risk=lose-ssh",
      "--accept-dns=false",
      "--accept-routes=false",
      "--timeout=45s",
      `--hostname=${initial}`,
      "--auth-key=file:/dev/stdin",
    ],
    { stdin: toBytes(key), quiet: true },
  );
  const nodeId = await waitForDevice(
    () => enrollingNode(api, instanceId),
    "Tailscale did not report the enrolled VM",
  );
  state.setTailscaleNode(instanceId, nodeId);
  const hostname = `cog-${name.toLowerCase().replaceAll(/[._]/g, "-")}`
    .slice(0, 63)
    .replace(/-+$/, "");
  await lima.shell(name, [
    "sudo",
    "tailscale",
    "set",
    `--hostname=${hostname}`,
  ]);
  const user = await lima.shellOutput(name, ["id", "-un"]);
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) {
    throw new CogError("invalid VM login name");
  }
  const dnsName = await waitForDevice(async () => {
    const device = object(await api(`device/${nodeId}?fields=all`, "GET"));
    const dns = device.name;
    if (
      device.nodeId !== nodeId ||
      device.sshEnabled !== true ||
      device.authorized !== true ||
      typeof dns !== "string"
    ) {
      return null;
    }
    if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+\.?$/i.test(dns)) {
      throw new CogError("invalid Tailscale MagicDNS name");
    }
    return dns.split(".", 1)[0] === initial ? null : dns.replace(/\.$/, "");
  }, "Tailscale did not report SSH ready at the VM's MagicDNS name");
  return `${user}@${dnsName}`;
}

export async function deleteTailscale(
  file: string,
  record: TailscaleNode,
): Promise<void> {
  const credential = tailscaleCredential(file);
  if (!credential) {
    throw new CogError(
      "Tailscale cleanup requires the credential; run cog tailscale config CLIENT-ID",
    );
  }
  const api = await connect(credential);
  let nodeId = record.nodeId;
  if (nodeId === null) {
    await api(`tailnet/-/keys/${record.keyId}`, "DELETE");
    nodeId = await enrollingNode(api, record.instanceId);
    if (nodeId === null) return;
  }
  await api(`device/${nodeId}`, "DELETE");
}
