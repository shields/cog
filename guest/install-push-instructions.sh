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

[[ $# -eq 1 && $1 =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || {
    printf '%s\n' 'install-push-instructions.sh: expected the VM instance ID' >&2
    exit 1
}

claude_md='' requirements=''
trap 'rm -f "$claude_md" "$requirements"' EXIT
claude_md=$(mktemp /etc/claude-code/.CLAUDE.md.XXXXXX)
requirements=$(mktemp /etc/codex/.requirements.toml.XXXXXX)

# Provisioning regenerates the agents' instruction files in the guest user's
# home, so the namespace goes in the system-wide ones.
sed "s/VM-ID/$1/g" >"$claude_md" <<'EOF'
Push to GitHub only branches named `cog/VM-ID/NAME`. For example, create your
branch with `git switch -c cog/VM-ID/fix-login`. Before every push, fetch the
latest tip of your base branch from its remote and rebase your work onto that
commit. For the first push, use `git push -u origin HEAD`.
The GitHub gateway rejects other pushes, branch deletions, and pushes to
repositories the user has not granted push access to. It also rejects GitHub
writes such as creating a pull request, so tell the user which branch you
pushed.
EOF
{
    printf '%s\n' "additional_developer_instructions = '''"
    cat "$claude_md"
    printf '%s\n' "'''"
} >"$requirements"
chmod 644 "$claude_md" "$requirements"
mv -f "$claude_md" /etc/claude-code/CLAUDE.md
mv -f "$requirements" /etc/codex/requirements.toml
