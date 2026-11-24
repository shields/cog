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

import { PolicyError, type Operation } from "./policy.ts";

export const claudeHost = "api.anthropic.com";
export const fireworksHost = "api.fireworks.ai";
export const placeholderCredential = "cog";

// "placeholder" is a request that carries the placeholder credential, which
// the gateway replaces with the host's own.
export type ModelRoute = "placeholder" | "direct";

export interface ModelHost {
  readonly host: string;
  readonly upstream: string;
  readonly upstreamOption: "anthropicUpstream" | "fireworksUpstream";
  readonly operation: Extract<Operation, `model.${string}`>;
  // Where the credential for a placeholder request comes from.
  readonly credential: "pool" | "key file";
}

// Dispatch is on the Host header, and each host's credential is resolved from
// its own entry, so one host's credential cannot reach another's upstream.
export const modelHosts: readonly ModelHost[] = [
  {
    host: claudeHost,
    upstream: `https://${claudeHost}`,
    upstreamOption: "anthropicUpstream",
    operation: "model.claude",
    credential: "pool",
  },
  {
    host: fireworksHost,
    upstream: `https://${fireworksHost}`,
    upstreamOption: "fireworksUpstream",
    operation: "model.fireworks",
    credential: "key file",
  },
];

export function modelHostFor(host: string | undefined): ModelHost | undefined {
  return modelHosts.find((candidate) => candidate.host === host);
}

// Header names and values in the order and spelling of IncomingMessage's
// rawHeaders, which keeps duplicates that the collapsed headers object merges
// or drops.
export type RawHeaders = readonly string[];

export type ModelClassification =
  { kind: "health" } | { kind: "forward"; route: ModelRoute };

export class ModelDenied extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = "ModelDenied";
  }
}

const unsupportedCharacter = /[^!-~]/u;

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const withheldRequestHeaders = new Set([...hopByHop, "expect"]);
const connectionOptions = new Set([...hopByHop, "close"]);

// The runtime's HTTP client sends a request that has no length as chunked
// unless its method is one of these, and writes any body that such a request
// has as bare bytes, which the provider would read as its next request.
const unframedMethods = new Set([
  "GET",
  "HEAD",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

function entries(headers: RawHeaders): [name: string, value: string][] {
  if (headers.length % 2 !== 0) {
    throw new Error("header list must alternate names and values");
  }
  const pairs: [string, string][] = [];
  for (let index = 0; index < headers.length; index += 2) {
    pairs.push([headers[index] ?? "", headers[index + 1] ?? ""]);
  }
  return pairs;
}

function valuesOf(pairs: [string, string][], name: string): string[] {
  return pairs
    .filter(([candidate]) => candidate.toLowerCase() === name)
    .map(([, value]) => value);
}

function deny(message: string): never {
  throw new ModelDenied(message);
}

function checkRequest(target: string, pairs: [string, string][]): void {
  if (!target.startsWith("/") || unsupportedCharacter.test(target)) {
    deny("request target must start with / and hold only printable ASCII");
  }
  if (valuesOf(pairs, "host").length !== 1) {
    deny("request must have exactly one Host header");
  }
  const lengths = valuesOf(pairs, "content-length").length;
  const codings = valuesOf(pairs, "transfer-encoding");
  // The runtime frames a body as chunked by itself, so any coding that the
  // client lists besides a single chunked would be dropped on the way.
  if (
    lengths > 1 ||
    (lengths === 1 && codings.length > 0) ||
    codings.length > 1 ||
    codings.some((coding) => coding.toLowerCase() !== "chunked")
  ) {
    deny("request framing is ambiguous");
  }
  // A header that Connection names is removed by a proxy, which would let a
  // client have Host, Authorization or Content-Length withheld after they
  // were checked.
  for (const option of connectionNamed(pairs)) {
    if (option !== "" && !connectionOptions.has(option)) {
      deny("Connection may name only hop-by-hop headers");
    }
  }
}

function route(pairs: [string, string][]): ModelRoute {
  if (valuesOf(pairs, "x-api-key").length > 0) {
    deny("this VM may not send its own credential");
  }
  const bearers = valuesOf(pairs, "authorization");
  if (bearers.length === 0) {
    return "direct";
  }
  if (
    bearers.length !== 1 ||
    bearers[0] !== `Bearer ${placeholderCredential}`
  ) {
    deny("this VM may send only the placeholder credential");
  }
  return "placeholder";
}

export function classifyModel(
  method: string,
  target: string,
  headers: RawHeaders,
): ModelClassification {
  const pairs = entries(headers);
  checkRequest(target, pairs);
  const verb = method.toUpperCase();
  // A provider that answers TRACE would send the substituted credential back.
  if (verb === "TRACE") {
    deny("TRACE is not forwarded");
  }
  if (
    unframedMethods.has(verb) &&
    valuesOf(pairs, "transfer-encoding").length > 0
  ) {
    deny("a request with this method must not be chunked");
  }
  return method === "GET" && target === "/__cog__/health"
    ? { kind: "health" }
    : { kind: "forward", route: route(pairs) };
}

export function modelRequestHeaders(
  incoming: RawHeaders,
  token: string | null,
): string[] {
  const kept: string[] = [];
  for (const [name, value] of entries(incoming)) {
    const lowered = name.toLowerCase();
    if (withheldRequestHeaders.has(lowered)) {
      continue;
    }
    kept.push(
      name,
      token !== null && lowered === "authorization" ? `Bearer ${token}` : value,
    );
  }
  return kept;
}

export function needsExplicitLength(
  method: string,
  incoming: RawHeaders,
): boolean {
  const pairs = entries(incoming);
  return (
    !unframedMethods.has(method.toUpperCase()) &&
    valuesOf(pairs, "content-length").length === 0 &&
    valuesOf(pairs, "transfer-encoding").length === 0
  );
}

// A request that the provider may already have acted on is sent again only
// when doing so changes nothing.
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isReplayable(method: string, incoming: RawHeaders): boolean {
  return safeMethods.has(method.toUpperCase()) && hasNoBody(incoming);
}

export function hasNoBody(incoming: RawHeaders): boolean {
  const pairs = entries(incoming);
  const lengths = valuesOf(pairs, "content-length");
  return (
    valuesOf(pairs, "transfer-encoding").length === 0 &&
    (lengths.length === 0 || lengths[0] === "0")
  );
}

function connectionNamed(pairs: [string, string][]): Set<string> {
  const named = new Set<string>();
  for (const value of valuesOf(pairs, "connection")) {
    for (const token of value.split(",")) {
      named.add(token.trim().toLowerCase());
    }
  }
  return named;
}

export function modelResponseHeaders(upstream: RawHeaders): string[] {
  const pairs = entries(upstream);
  const named = connectionNamed(pairs);
  const kept: string[] = [];
  for (const [name, value] of pairs) {
    const lowered = name.toLowerCase();
    if (!hopByHop.has(lowered) && !named.has(lowered)) {
      kept.push(name, value);
    }
  }
  return kept;
}

// A refusal is final, so the client is told not to send the request again. A
// failure to reach the provider is left to the client's own retry rule.
export function modelRefusal(
  status: 403 | 503,
  reason: string,
  requestId: string,
  final: boolean,
): { headers: Record<string, string>; body: string } {
  return {
    headers: {
      "content-type": "application/json",
      ...(final ? { "x-should-retry": "false" } : {}),
    },
    body: JSON.stringify({
      type: "error",
      error: {
        type: status === 403 ? "permission_error" : "api_error",
        message: `cog gateway: ${reason}`,
      },
      request_id: requestId,
    }),
  };
}
