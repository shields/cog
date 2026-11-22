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

usage='usage: sudo agent.sh --user NAME'

die() {
    printf 'agent.sh: %s\n' "$*" >&2
    exit 1
}

[[ $# -eq 2 && $1 == --user && -n $2 && $2 != -* ]] || die "$usage"
user=$2
[[ $(id -u) -eq 0 ]] || die 'run as root'
home=$(getent passwd "$user" | cut -d: -f6)
[[ -n $home && -d $home ]] || die "cannot find the home directory of $user"

settings=/etc/claude-code/managed-settings.json
[[ -f $settings ]] || die 'managed settings are missing'
managed=$(mktemp /etc/claude-code/.managed-settings.XXXXXX)
trap 'rm -f "$managed"' EXIT
jq '.permissions.deny |= map(select(. as $entry | [
    "Bash(git push*)",
    "Bash(git -C * push*)",
    "Bash(git -c * push*)",
    "Bash(git --git-dir* push*)",
    "Bash(git --work-tree* push*)"
  ] | index($entry) | not))' "$settings" >"$managed"
chmod 644 "$managed"
mv -f "$managed" "$settings"

rm -f "$home/.codex/rules/no-push.rules"
sudo -H -u "$user" git config --global credential.https://github.com.helper '!/usr/local/lib/cog/github-gateway-credential'
printf '%s\n' cloudflare >/etc/cog-github-gateway
chmod 644 /etc/cog-github-gateway
