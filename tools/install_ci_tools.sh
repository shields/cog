#!/usr/bin/env bash

# Copyright © 2026 Michael Shields
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Install what `make lint build test` needs on a GitHub-hosted ubuntu-26.04
# runner, which has none of the Homebrew toolset the Mac is provisioned with.
#
# It changes the machine it runs on (sudo apt-get, Homebrew, ~/.local), so it
# refuses to run anywhere but a runner. Every test must run: the tests fail
# when codex, limactl or jq is missing, and COG_FAIL_ON_SKIP turns any skip into
# a failure.
#
# Lima is not from Homebrew because its formula pulls in qemu; it is pinned with
# a checksum and bumped by hand. Everything else floats: the Homebrew formulae
# and cask, and basedpyright from PyPI. shfmt must be 3.14 or newer for
# `make lint`.

set -euo pipefail

lima_version=2.3.0
lima_sha256=cc8ba97f1c801b899f7c9eda9919dfc4ce4fa2c140c53e5add15aa2d0a1936f9

brew_prefix=/home/linuxbrew/.linuxbrew
local_prefix=$HOME/.local

die() {
    printf 'install_ci_tools: %s\n' "$*" >&2
    exit 1
}

[[ ${GITHUB_ACTIONS:-} == true ]] || die "not a GitHub Actions runner; refusing to change this machine"
[[ -n ${GITHUB_PATH:-} ]] || die "GITHUB_PATH is not set"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die "only x86_64 Linux runners are supported"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

retry() {
    local attempt
    for attempt in 1 2 3; do
        "$@" && return 0
        if [[ $attempt -lt 3 ]]; then
            sleep $((attempt * 10))
        fi
    done
    die "failed after 3 attempts: $*"
}

download() {
    local url=$1 sha256=$2 dest=$3
    curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
        --connect-timeout 20 --max-time 600 --speed-limit 102400 --speed-time 30 \
        --output "$dest" "$url"
    printf '%s  %s\n' "$sha256" "$dest" | sha256sum --check --strict --status ||
        die "checksum mismatch for $url"
}

# bsdtar is what tests/test_stage_tree.py runs an extra variant against when it
# is on PATH. Without it the variant is dropped, not skipped, so the skip gate
# cannot see it.
retry sudo apt-get update
retry sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    jq libarchive-tools openssl perl zsh

# Homebrew is on the image but not on PATH. shfmt 3.14 is newer than
# Ubuntu's, and gitleaks must have `gitleaks dir`.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
retry "$brew_prefix/bin/brew" install gitleaks shfmt
retry "$brew_prefix/bin/brew" install --cask codex
export PATH="$brew_prefix/bin:$local_prefix/bin:$PATH"
printf '%s\n' "$brew_prefix/bin" "$local_prefix/bin" >>"$GITHUB_PATH"

retry uv tool install basedpyright
# tests/test_github_app_token.py runs the token tool under Python 3.13. A
# download that uv started inside the test would not be retried.
retry uv python install 3.13

mkdir -p "$local_prefix/bin"
download "https://github.com/lima-vm/lima/releases/download/v$lima_version/lima-$lima_version-Linux-x86_64.tar.gz" \
    "$lima_sha256" "$work_dir/lima.tar.gz"
tar -xzf "$work_dir/lima.tar.gz" -C "$local_prefix"

codex --version
limactl --version
bsdtar --version
