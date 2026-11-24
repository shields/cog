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
import {
  classifyModel,
  hasNoBody,
  isReplayable,
  ModelDenied,
  modelRefusal,
  modelHostFor,
  modelHosts,
  modelRequestHeaders,
  modelResponseHeaders,
  needsExplicitLength,
} from "./models.ts";

const host = ["Host", "api.anthropic.com"];
const placeholder = ["Authorization", "Bearer cog"];
const token = "sk-ant-oat01-made-up-token";

function classify(
  target: string,
  headers: string[] = [...host],
  method = "POST",
): string {
  try {
    const result = classifyModel(method, target, headers);
    return result.kind === "health" ? "health" : result.route;
  } catch (error) {
    assert.ok(error instanceof ModelDenied, String(error));
    return "refused";
  }
}

test("targets are judged only by their first character and their bytes, never decoded or normalised", () => {
  const cases: [string, string][] = [
    ["/v1/messages", "direct"],
    ["/v1/messages?beta=true", "direct"],
    ["/", "direct"],
    ["//x", "direct"],
    ["/a/../b/./c", "direct"],
    ["/a%2f..%2fb/%zz/%00", "direct"],
    ["/a\\b#frag", "direct"],
    ["/api/claude_cli/bootstrap", "direct"],
    ["/v1/x?a='b'&c={d}|[e]^f&g=%7B%22h%22%3A1%7D&i=%C3%BC&j=\"<>`", "direct"],
    [`/v1/x?${"q=%41&".repeat(3000)}`, "direct"],
    ["http://api.anthropic.com/v1/messages", "refused"],
    ["api.anthropic.com:443", "refused"],
    ["*", "refused"],
    ["", "refused"],
    ["v1/messages", "refused"],
    ["/v1/a b", "refused"],
    ["/v1/a\tb", "refused"],
    ["/v1/a\nb", "refused"],
    ["/v1/a\u{0}b", "refused"],
    ["/v1/a\u{7F}b", "refused"],
    ["/v1/\u{FC}", "refused"],
    ["/v1/\u{1F600}", "refused"],
  ];
  for (const [target, expected] of cases) {
    assert.equal(classify(target), expected, JSON.stringify(target));
  }
});

test("the exact health target is answered locally, and nothing else is", () => {
  assert.equal(classify("/__cog__/health", [...host], "GET"), "health");
  assert.equal(
    classify("/__cog__/health", [...host, "x-api-key", "k"], "GET"),
    "health",
  );
  assert.equal(classify("/__cog__/health?x=1", [...host], "GET"), "direct");
  assert.equal(classify("/__cog__/health/", [...host], "GET"), "direct");
  assert.equal(classify("/__cog__/Health", [...host], "GET"), "direct");
  assert.equal(classify("/__cog__/health", [...host], "POST"), "direct");
  assert.equal(classify("/__cog__/health", [], "GET"), "refused");
});

test("credentials are classified on the raw header lines", () => {
  const cases: [string, string[], string][] = [
    ["no credential", [], "direct"],
    ["the placeholder", placeholder, "placeholder"],
    ["lower-case name", ["authorization", "Bearer cog"], "placeholder"],
    ["upper-case name", ["AUTHORIZATION", "Bearer cog"], "placeholder"],
    ["mixed-case name", ["AuThOrIzAtIoN", "Bearer cog"], "placeholder"],
    ["lower-case scheme", ["Authorization", "bearer cog"], "refused"],
    ["upper-case scheme", ["Authorization", "BEARER cog"], "refused"],
    ["trailing space", ["Authorization", "Bearer cog "], "refused"],
    ["leading space", ["Authorization", " Bearer cog"], "refused"],
    ["two spaces", ["Authorization", "Bearer  cog"], "refused"],
    ["upper-case value", ["Authorization", "Bearer COG"], "refused"],
    ["no scheme", ["Authorization", "cog"], "refused"],
    ["empty value", ["Authorization", ""], "refused"],
    ["a real-looking token", ["Authorization", `Bearer ${token}`], "refused"],
    ["basic", ["Authorization", "Basic Y29nOg=="], "refused"],
    [
      "the placeholder twice",
      [...placeholder, "authorization", "Bearer cog"],
      "refused",
    ],
    [
      "placeholder then token",
      [...placeholder, "authorization", `Bearer ${token}`],
      "refused",
    ],
    [
      "token then placeholder",
      ["authorization", `Bearer ${token}`, ...placeholder],
      "refused",
    ],
    ["x-api-key alone", ["x-api-key", "sk-ant-api03-x"], "refused"],
    ["x-api-key in other case", ["X-API-Key", "k"], "refused"],
    ["x-api-key empty", ["x-api-key", ""], "refused"],
    [
      "x-api-key with the placeholder",
      [...placeholder, "x-api-key", "k"],
      "refused",
    ],
    [
      "x-api-key before the placeholder",
      ["x-api-key", "k", ...placeholder],
      "refused",
    ],
    [
      "proxy-authorization is not a credential",
      ["Proxy-Authorization", "Basic x"],
      "direct",
    ],
    ["cookie is not a credential", ["Cookie", "a=b"], "direct"],
  ];
  for (const [name, headers, expected] of cases) {
    assert.equal(
      classify("/v1/messages", [...host, ...headers]),
      expected,
      name,
    );
  }
});

test("exactly one Host header is required, whatever its spelling", () => {
  assert.equal(classify("/x", []), "refused");
  assert.equal(classify("/x", ["host", "api.anthropic.com"]), "direct");
  assert.equal(classify("/x", ["HOST", "api.anthropic.com"]), "direct");
  assert.equal(
    classify("/x", [...host, "host", "api.anthropic.com"]),
    "refused",
  );
  assert.equal(classify("/x", [...host, "Host", "other"]), "refused");
  assert.equal(
    classify("/x", [...host, ...placeholder, "HOST", "x"]),
    "refused",
  );
});

test("a request that the two sides could frame differently is refused", () => {
  const cases: [string, string[], string][] = [
    ["no framing header", [], "direct"],
    ["one Content-Length", ["Content-Length", "2"], "direct"],
    ["one Transfer-Encoding", ["Transfer-Encoding", "chunked"], "direct"],
    [
      "two Content-Length lines, equal",
      ["Content-Length", "2", "content-length", "2"],
      "refused",
    ],
    [
      "two Content-Length lines, different",
      ["Content-Length", "2", "content-length", "3"],
      "refused",
    ],
    [
      "both",
      ["Content-Length", "2", "Transfer-Encoding", "chunked"],
      "refused",
    ],
    [
      "both, other case",
      ["content-length", "2", "TRANSFER-ENCODING", "chunked"],
      "refused",
    ],
    [
      "both, other order",
      ["Transfer-Encoding", "chunked", "Content-Length", "2"],
      "refused",
    ],
    [
      "a pooled request with both",
      [...placeholder, "Content-Length", "2", "Transfer-Encoding", "chunked"],
      "refused",
    ],
    ["chunked in another case", ["Transfer-Encoding", "Chunked"], "direct"],
    [
      "two Transfer-Encoding lines",
      ["Transfer-Encoding", "chunked", "transfer-encoding", "chunked"],
      "refused",
    ],
    [
      "a coding besides chunked",
      ["Transfer-Encoding", "gzip, chunked"],
      "refused",
    ],
    [
      "a coding that is not chunked",
      ["Transfer-Encoding", "identity"],
      "refused",
    ],
    [
      "a pooled request with a coding besides chunked",
      [...placeholder, "Transfer-Encoding", "gzip, chunked"],
      "refused",
    ],
  ];
  for (const [name, headers, expected] of cases) {
    assert.equal(classify("/x", [...host, ...headers]), expected, name);
  }
});

test("TRACE and a chunked body on a method that the client sends unframed are refused", () => {
  const chunked = ["Transfer-Encoding", "chunked"];
  const cases: [string, string[], string][] = [
    ["DELETE", chunked, "refused"],
    ["delete", chunked, "refused"],
    ["OPTIONS", chunked, "refused"],
    ["CONNECT", chunked, "refused"],
    ["GET", chunked, "refused"],
    ["HEAD", chunked, "refused"],
    ["DELETE", [...placeholder, ...chunked], "refused"],
    ["DELETE", ["Content-Length", "2"], "direct"],
    ["DELETE", [], "direct"],
    ["OPTIONS", [...placeholder, "Content-Length", "2"], "placeholder"],
    ["POST", chunked, "direct"],
    ["PUT", [...placeholder, ...chunked], "placeholder"],
    ["PATCH", chunked, "direct"],
    ["TRACE", [], "refused"],
    ["trace", ["Content-Length", "2"], "refused"],
    ["TRACE", [...placeholder, ...chunked], "refused"],
  ];
  for (const [method, headers, expected] of cases) {
    assert.equal(
      classify("/x", [...host, ...headers], method),
      expected,
      `${method} ${headers.join(" ")}`,
    );
  }
});

test("a Connection header may name only hop-by-hop headers, so it cannot have a checked header withheld", () => {
  const cases: [string, string][] = [
    ["close", "placeholder"],
    ["keep-alive", "placeholder"],
    ["Keep-Alive, TE", "placeholder"],
    ["Upgrade", "placeholder"],
    ["close,, ", "placeholder"],
    ["authorization", "refused"],
    ["close, Authorization", "refused"],
    ["host", "refused"],
    ["content-length", "refused"],
    ["x-api-key", "refused"],
    ["x-hop", "refused"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(
      classify("/x", [...host, ...placeholder, "Connection", value]),
      expected,
      value,
    );
  }
  assert.equal(
    classify("/x", [...host, "Connection", "close", "connection", "x-hop"]),
    "refused",
  );
});

test("a refusal says which rule applied and carries the model operation's shape", () => {
  const reasons = new Set<string>();
  for (const [target, headers] of [
    ["http://x/", [...host]],
    ["/x", []],
    ["/x", [...host, "x-api-key", "k"]],
    ["/x", [...host, "Authorization", "Bearer other"]],
    ["/x", [...host, "Content-Length", "1", "Content-Length", "1"]],
    ["/x", [...host, "Connection", "authorization"]],
  ] as [string, string[]][]) {
    try {
      classifyModel("POST", target, headers);
      assert.fail("not refused");
    } catch (error) {
      assert.ok(error instanceof ModelDenied);
      reasons.add(error.message);
    }
  }
  assert.equal(reasons.size, 6);
});

test("the request header builder keeps order, spelling and duplicates, and changes only the credential", () => {
  const incoming = [
    "Host",
    "api.anthropic.com",
    "X-Dup",
    "one",
    "AUTHORIZATION",
    "Bearer cog",
    "x-dup",
    "two",
    "User-Agent",
    "claude-cli/2.1 (external, cli)",
    "Content-Length",
    "12",
    "Anthropic-Beta",
    "a",
    "anthropic-beta",
    "b",
    "X-Same",
    "1",
    "X-Same",
    "2",
  ];
  assert.deepEqual(modelRequestHeaders(incoming, token), [
    "Host",
    "api.anthropic.com",
    "X-Dup",
    "one",
    "AUTHORIZATION",
    `Bearer ${token}`,
    "x-dup",
    "two",
    "User-Agent",
    "claude-cli/2.1 (external, cli)",
    "Content-Length",
    "12",
    "Anthropic-Beta",
    "a",
    "anthropic-beta",
    "b",
    "X-Same",
    "1",
    "X-Same",
    "2",
  ]);
  const substituted = modelRequestHeaders(incoming, token);
  assert.equal(substituted.filter((value) => value.includes(token)).length, 1);
  assert.equal(substituted.length, incoming.length);
});

test("the direct route forwards the client's list as it is, apart from the removals", () => {
  const incoming = [
    "Host",
    "api.anthropic.com",
    "Cookie",
    "a=b",
    "X-Forwarded-For",
    "198.51.100.7",
    "Via",
    "1.1 guest",
    "Proxy-Authorization",
    "x",
    "Forwarded",
    "for=x",
    "x-instance",
    "another",
    "Content-Type",
    "application/json",
  ];
  assert.deepEqual(modelRequestHeaders(incoming, null), [
    "Host",
    "api.anthropic.com",
    "Cookie",
    "a=b",
    "X-Forwarded-For",
    "198.51.100.7",
    "Via",
    "1.1 guest",
    "Forwarded",
    "for=x",
    "x-instance",
    "another",
    "Content-Type",
    "application/json",
  ]);
  const bytes = ["Host", "h", "Authorization", "Bearer cog"];
  assert.deepEqual(modelRequestHeaders(bytes, null), bytes);
  assert.deepEqual(modelRequestHeaders([], null), []);
});

test("hop-by-hop headers and Expect are removed", () => {
  const incoming = [
    "Host",
    "h",
    "Connection",
    "Keep-Alive, TE",
    "connection",
    "upgrade",
    "Keep-Alive",
    "timeout=5",
    "Proxy-Authenticate",
    "x",
    "Proxy-Authorization",
    "x",
    "TE",
    "trailers",
    "Trailer",
    "x",
    "Transfer-Encoding",
    "chunked",
    "Upgrade",
    "websocket",
    "Expect",
    "100-continue",
    "X-Kept",
    "1",
  ];
  assert.deepEqual(modelRequestHeaders(incoming, null), [
    "Host",
    "h",
    "X-Kept",
    "1",
  ]);
  assert.deepEqual(modelRequestHeaders(incoming, token), [
    "Host",
    "h",
    "X-Kept",
    "1",
  ]);
});

test("the builders reject a list that does not pair names with values", () => {
  assert.throws(() => modelRequestHeaders(["Host"], null));
  assert.throws(() => modelResponseHeaders(["a"]));
});

test("a body-less request is told from one that has a body", () => {
  assert.equal(hasNoBody([...host]), true);
  assert.equal(hasNoBody([...host, "Content-Length", "0"]), true);
  assert.equal(hasNoBody([...host, "Content-Length", "1"]), false);
  assert.equal(hasNoBody([...host, "Transfer-Encoding", "chunked"]), false);
  assert.equal(needsExplicitLength("POST", [...host]), true);
  assert.equal(needsExplicitLength("post", [...host]), true);
  assert.equal(needsExplicitLength("PUT", [...host]), true);
  assert.equal(needsExplicitLength("PROPFIND", [...host]), true);
  assert.equal(
    needsExplicitLength("POST", [...host, "Content-Length", "0"]),
    false,
  );
  assert.equal(
    needsExplicitLength("POST", [...host, "Transfer-Encoding", "chunked"]),
    false,
  );
  for (const method of [
    "GET",
    "HEAD",
    "DELETE",
    "OPTIONS",
    "TRACE",
    "CONNECT",
    "get",
  ]) {
    assert.equal(needsExplicitLength(method, [...host]), false, method);
  }
});

test("only a safe request with no body is sent again after a reset", () => {
  for (const [method, headers, expected] of [
    ["GET", [...host], true],
    ["get", [...host], true],
    ["HEAD", [...host], true],
    ["OPTIONS", [...host, "Content-Length", "0"], true],
    ["GET", [...host, "Content-Length", "2"], false],
    ["GET", [...host, "Transfer-Encoding", "chunked"], false],
    ["POST", [...host], false],
    ["POST", [...host, "Content-Length", "0"], false],
    ["PATCH", [...host], false],
    ["PUT", [...host], false],
    ["DELETE", [...host], false],
  ] as const) {
    assert.equal(
      isReplayable(method, headers),
      expected,
      `${method} ${headers.join(" ")}`,
    );
  }
});

test("response headers keep order, spelling and duplicates, and lose only hop-by-hop headers and those Connection names", () => {
  const upstream = [
    "Content-Type",
    "text/event-stream",
    "Set-Cookie",
    "a=1",
    "set-cookie",
    "b=2",
    "Connection",
    "X-Hop",
    "Keep-Alive",
    "timeout=5",
    "Transfer-Encoding",
    "chunked",
    "X-Hop",
    "1",
    "Proxy-Authenticate",
    "x",
    "Trailer",
    "x",
    "TE",
    "x",
    "Upgrade",
    "x",
    "Proxy-Authorization",
    "x",
    "Content-Encoding",
    "gzip",
    "request-id",
    "req_1",
    "x-other-request-id",
    "kept",
    "x-should-retry",
    "false",
    "Content-Length",
    "5",
  ];
  assert.deepEqual(modelResponseHeaders(upstream), [
    "Content-Type",
    "text/event-stream",
    "Set-Cookie",
    "a=1",
    "set-cookie",
    "b=2",
    "Content-Encoding",
    "gzip",
    "request-id",
    "req_1",
    "x-other-request-id",
    "kept",
    "x-should-retry",
    "false",
    "Content-Length",
    "5",
  ]);
});

test("a refusal is the provider's error shape with the right type for its status, and only a final one tells the client not to retry", () => {
  assert.deepEqual(modelRefusal(503, "no way", "req-1", false).headers, {
    "content-type": "application/json",
  });
  for (const [status, type] of [
    [403, "permission_error"],
    [503, "api_error"],
  ] as const) {
    const refusal = modelRefusal(status, "no way", "req-1", true);
    assert.deepEqual(refusal.headers, {
      "content-type": "application/json",
      "x-should-retry": "false",
    });
    assert.deepEqual(JSON.parse(refusal.body), {
      type: "error",
      error: { type, message: "cog gateway: no way" },
      request_id: "req-1",
    });
  }
});

test("the model hosts are an explicit table that is matched on the exact Host value", () => {
  assert.deepEqual(
    modelHosts.map(({ host, upstream, operation, credential }) => [
      host,
      upstream,
      operation,
      credential,
    ]),
    [
      [
        "api.anthropic.com",
        "https://api.anthropic.com",
        "model.claude",
        "pool",
      ],
      [
        "api.fireworks.ai",
        "https://api.fireworks.ai",
        "model.fireworks",
        "key file",
      ],
    ],
  );
  assert.equal(modelHostFor("api.fireworks.ai")?.operation, "model.fireworks");
  assert.equal(modelHostFor("api.anthropic.com")?.operation, "model.claude");
  for (const other of [
    undefined,
    "",
    "github.com",
    "api.fireworks.ai:443",
    "API.FIREWORKS.AI",
    "api.fireworks.ai.",
    "fireworks.ai",
    "x.api.fireworks.ai",
  ]) {
    assert.equal(modelHostFor(other), undefined, String(other));
  }
});

test("the Fireworks host is held to the same request rules", () => {
  const fireworksHost = ["Host", "api.fireworks.ai"];
  const cases: [string, string[], string, string][] = [
    ["/inference/v1/messages?beta=true", [], "POST", "direct"],
    ["/inference/api/hello", [], "HEAD", "direct"],
    ["/inference/v1/messages", placeholder, "POST", "placeholder"],
    [
      "/inference/v1/messages",
      ["Authorization", "Bearer x"],
      "POST",
      "refused",
    ],
    ["/inference/v1/messages", ["x-api-key", "k"], "POST", "refused"],
    [
      "/inference/v1/messages",
      [...placeholder, "x-api-key", "k"],
      "POST",
      "refused",
    ],
    [
      "/inference/v1/messages",
      [...placeholder, "Connection", "authorization"],
      "POST",
      "refused",
    ],
    ["/inference/v1/messages", placeholder, "TRACE", "refused"],
    [
      "/inference/v1/messages",
      [...placeholder, "Transfer-Encoding", "chunked"],
      "GET",
      "refused",
    ],
    ["inference/v1/messages", [], "POST", "refused"],
    ["/__cog__/health", [], "GET", "health"],
  ];
  for (const [target, headers, method, expected] of cases) {
    assert.equal(
      classify(target, [...fireworksHost, ...headers], method),
      expected,
      `${method} ${target} ${headers.join(" ")}`,
    );
  }
  assert.equal(
    classify("/x", [...fireworksHost, "Host", "api.fireworks.ai"]),
    "refused",
  );
});

test("a key replaces the placeholder in place, and everything else in the list stays", () => {
  const key = "fw-made-up-one";
  const incoming = [
    "Host",
    "api.fireworks.ai",
    "X-A",
    "1",
    "aUtHoRiZaTiOn",
    "Bearer cog",
    "x-a",
    "2",
  ];
  assert.deepEqual(modelRequestHeaders(incoming, key), [
    "Host",
    "api.fireworks.ai",
    "X-A",
    "1",
    "aUtHoRiZaTiOn",
    `Bearer ${key}`,
    "x-a",
    "2",
  ]);
});
