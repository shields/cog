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

import { CogError } from "./errors.ts";

const namePattern = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const wholeNumber = /^[1-9][0-9]*$/;

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validName(name: string): string {
  if (!namePattern.test(name)) {
    throw new CogError(`invalid VM name: ${name}`);
  }
  return name;
}

export function validRepository(repository: string): string {
  if (
    !repositoryPattern.test(repository) ||
    repository.startsWith("./") ||
    repository.startsWith("../") ||
    repository.endsWith("/.") ||
    repository.endsWith("/..")
  ) {
    throw new CogError(
      `invalid repository, expected OWNER/REPO: ${repository}`,
    );
  }
  return repository;
}

// The gateway keeps the name of a Lima VM with this prefix.
export function gatewayName(name: string): string {
  return `lima:${name}`;
}

function lowercase(text: string): string {
  return text.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// Plain string operations, because `new URL` would normalize the input.
export function githubHost(webUrl: string): string {
  const scheme = webUrl.indexOf("://");
  let host = scheme === -1 ? webUrl : webUrl.slice(scheme + 3);
  const slash = host.indexOf("/");
  if (slash !== -1) {
    host = host.slice(0, slash);
  }
  host = host.slice(host.lastIndexOf("@") + 1);
  const colon = host.indexOf(":");
  if (colon !== -1) {
    host = host.slice(0, colon);
  }
  return lowercase(host);
}

// The caller validates the result.
export function originRepository(url: string, webUrl: string): string | null {
  let authority: string;
  let repository: string;
  if (url.startsWith("git@") && url.includes(":", 4)) {
    const rest = url.slice(4);
    const colon = rest.indexOf(":");
    authority = rest.slice(0, colon);
    repository = rest.slice(colon + 1);
  } else if (url.startsWith("ssh://git@") && url.includes("/", 10)) {
    const rest = url.slice(10);
    const slash = rest.indexOf("/");
    authority = rest.slice(0, slash);
    repository = rest.slice(slash + 1);
  } else if (url.startsWith("https://") && url.includes("/", 8)) {
    const rest = url.slice(8);
    const slash = rest.indexOf("/");
    authority = rest.slice(0, slash);
    repository = rest.slice(slash + 1);
  } else {
    return null;
  }
  const colon = authority.indexOf(":");
  authority = lowercase(colon === -1 ? authority : authority.slice(0, colon));
  if (authority !== githubHost(webUrl)) {
    return null;
  }
  if (repository.startsWith("/")) {
    repository = repository.slice(1);
  }
  if (repository.endsWith("/")) {
    repository = repository.slice(0, -1);
  }
  if (repository.endsWith(".git")) {
    repository = repository.slice(0, -4);
  }
  return repository;
}

// The base's origin becomes HTTPS, because the guest holds no SSH key, and
// anything that could carry a credential is refused.
export function normalizeOrigin(origin: string): string {
  let result = origin;
  if (result.startsWith("git@github.com:")) {
    result = `https://github.com/${result.slice("git@github.com:".length)}`;
  } else if (result.startsWith("ssh://git@github.com/")) {
    result = `https://github.com/${result.slice("ssh://git@github.com/".length)}`;
  }
  const scheme = result.indexOf("://");
  if (scheme !== -1) {
    let authority = result.slice(scheme + 3);
    const slash = authority.indexOf("/");
    if (slash !== -1) {
      authority = authority.slice(0, slash);
    }
    if (authority.includes("@")) {
      throw new CogError("origin must not contain credentials");
    }
  }
  if (
    result.includes("?") ||
    result.includes("#") ||
    hasControlCharacter(result)
  ) {
    throw new CogError(
      "origin must not contain query parameters, fragments or control characters",
    );
  }
  return result;
}

export function sizeArgs(cpus: string, memory: string): string[] {
  const args: string[] = [];
  if (cpus !== "") {
    if (!wholeNumber.test(cpus)) {
      throw new CogError("COG_CPUS must be a whole number");
    }
    args.push("--cpus", cpus);
  }
  if (memory !== "") {
    if (!wholeNumber.test(memory)) {
      throw new CogError("COG_MEMORY must be a whole number of GiB");
    }
    args.push("--memory", memory);
  }
  return args;
}
