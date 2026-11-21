#!/bin/bash

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

set -euo pipefail

worker_only=0
if [[ $# -eq 1 && $1 == --worker-only ]]; then
    worker_only=1
elif [[ $# -ne 0 ]]; then
    printf '%s\n' 'Usage: cloudflare/deploy.sh [--worker-only]' >&2
    exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
secret_dir=$HOME/.config/secrets/cog
token_file=$secret_dir/cloudflare-admin-token
install -d -m 0700 "$secret_dir"
if [[ ! -e $token_file ]]; then
    umask 077
    openssl rand -hex 32 >"$token_file"
fi
[[ $(stat -f %Lp "$token_file" 2>/dev/null || stat -c %a "$token_file") == 600 ]] || {
    printf '%s\n' 'Cloudflare admin token must have mode 0600' >&2
    exit 1
}
[[ $(wc -c <"$token_file") -eq 65 ]] || {
    printf '%s\n' 'Cloudflare admin token is invalid' >&2
    exit 1
}

stage=$(mktemp -d "${TMPDIR:-/tmp}/cog-cloudflare.XXXXXX")
trap 'rm -rf "$stage"' EXIT
"$root/tools/stage_tree.sh" "$stage/tree"
cd "$stage/tree"
public_key=$(cat "$HOME/.ssh/id_ed25519.pub")
[[ $public_key == ssh-ed25519\ * ]] || {
    printf '%s\n' 'Cloudflare SSH requires ~/.ssh/id_ed25519.pub' >&2
    exit 1
}
jq --arg key "$public_key" \
    '.containers[0].authorized_keys = [{name: "owner", public_key: $key}]' \
    cloudflare/wrangler.jsonc >"$stage/wrangler.jsonc"
mv "$stage/wrangler.jsonc" cloudflare/wrangler.jsonc
bun install --frozen-lockfile
umask 077
{
    printf 'ADMIN_TOKEN='
    cat "$token_file"
} >"$stage/admin.env"
set -- --config cloudflare/wrangler.jsonc --secrets-file "$stage/admin.env"
if [[ $worker_only == 1 ]]; then
    set -- "$@" --containers-rollout=none
fi
bunx wrangler deploy "$@"
