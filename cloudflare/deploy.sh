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

usage="usage: cloudflare/deploy.sh [--worker-only] [--dotfiles DIR]"
worker_only=0
dotfiles_args=()
have_dotfiles=0
while (($#)); do
    case $1 in
    --worker-only)
        worker_only=1
        shift
        ;;
    --dotfiles)
        [[ $# -ge 2 && -n $2 ]] || {
            printf '%s\n' "$usage" >&2
            exit 2
        }
        ((! have_dotfiles)) || {
            printf '%s\n' '--dotfiles was given twice' >&2
            exit 2
        }
        dotfiles_args=(--dotfiles "$2")
        have_dotfiles=1
        shift 2
        ;;
    *)
        printf '%s\n' "$usage" >&2
        exit 2
        ;;
    esac
done
if ((worker_only && have_dotfiles)); then
    printf '%s\n' '--dotfiles has no use with --worker-only' >&2
    exit 2
fi

unset CDPATH
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
secret_dir=$HOME/.config/secrets/cog
token_file=$secret_dir/cloudflare-admin-token
install -d -m 0700 "$secret_dir"
if [[ ! -e $token_file && ! -L $token_file ]]; then
    (
        umask 077
        pending=$(mktemp "$secret_dir/.cloudflare-admin-token.XXXXXX")
        trap 'rm -f "$pending"' EXIT
        openssl rand -hex 32 >"$pending"
        if ! link "$pending" "$token_file" 2>/dev/null && [[ ! -e $token_file ]]; then
            printf '%s\n' 'Cannot store Cloudflare admin token' >&2
            exit 1
        fi
    )
fi
[[ -f $token_file && ! -L $token_file && $(stat -c %a "$token_file" 2>/dev/null || stat -f %Lp "$token_file") == 600 ]] || {
    printf '%s\n' 'Cloudflare admin token must be a regular file with mode 0600' >&2
    exit 1
}

stage=$(mktemp -d "${TMPDIR:-/tmp}/cog-cloudflare.XXXXXX")
trap 'rm -rf "$stage"' EXIT
(
    set +x
    umask 077
    export LC_ALL=C
    token_pattern=$'^[0-9a-f]{64}\n$'
    if IFS= read -r -d '' -n 66 admin_token || [[ ! $admin_token =~ $token_pattern ]]; then
        printf '%s\n' 'Cloudflare admin token is invalid' >&2
        exit 1
    fi
    printf 'ADMIN_TOKEN=%s' "$admin_token" >"$stage/admin.env"
) <"$token_file"
"$root/tools/stage_tree.sh" "$stage/tree"
if ((worker_only)); then
    context=$stage/tree
else
    context=$stage/context
    "$root/cloudflare/context.sh" "$context" ${dotfiles_args[@]+"${dotfiles_args[@]}"}
fi
cd "$stage/tree"
public_key=$(cat "$HOME/.ssh/id_ed25519.pub")
[[ $public_key == ssh-ed25519\ * ]] || {
    printf '%s\n' 'Cloudflare SSH requires ~/.ssh/id_ed25519.pub' >&2
    exit 1
}
jq --arg key "$public_key" --arg dockerfile "$stage/tree/cloudflare/Dockerfile" --arg context "$context" \
    '.containers[0].authorized_keys = [{name: "owner", public_key: $key}]
    | .containers[0].images.base.dockerfile = $dockerfile
    | .containers[0].images.base.build_context = $context' \
    cloudflare/wrangler.jsonc >"$stage/wrangler.jsonc"
mv "$stage/wrangler.jsonc" cloudflare/wrangler.jsonc
bun install --frozen-lockfile
umask 077
set -- --config cloudflare/wrangler.jsonc --secrets-file "$stage/admin.env"
if [[ $worker_only == 1 ]]; then
    set -- "$@" --containers-rollout=none
fi
bunx wrangler deploy "$@"
printf '%s\n' 'Save the HTTPS URL from Wrangler with cog cloud config HTTPS-WORKER-URL.'
printf '%s\n' 'Run cog cloud authorize OWNER/REPO for each repository the Worker should serve.'
