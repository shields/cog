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

# Assembles the build context of the agent image in DEST, which must be a new or
# empty directory outside this repository and the dotfiles checkout:
#   DEST/dotfiles    a staged, scanned copy of the dotfiles checkout
#   DEST/guest       this repository's guest/
#   DEST/cloudflare  this repository's cloudflare/guest/

set -euo pipefail

usage="usage: cloudflare/context.sh DEST [--dotfiles DIR]"
default_dotfiles=$HOME/src/github.com/shields/dotfiles

die() {
    printf 'context.sh: %s\n' "$*" >&2
    exit 1
}

marker_readers=(
    .zshrc:/etc/cog-throwaway
    .zshrc:/etc/cog-gateway
    .zshenv:/etc/cog-gateway
    .zsh.d/wt.zsh:/etc/cog-gateway
    .codex/hooks/git_guard.py:/etc/cog-gateway
    tools/configure_codex.py:/etc/cog-throwaway
    provision.sh:/etc/cog-gateway
    .claude/statusline.sh:/etc/cog-gateway
)

check_marker_readers() {
    local tree=$1 entry file marker
    for entry in "${marker_readers[@]}"; do
        file=${entry%%:*}
        marker=${entry#*:}
        if [[ ! -f $tree/$file || -L $tree/$file ]] || ! grep -qF -- "$marker" "$tree/$file"; then
            die "$file in the dotfiles checkout does not name $marker, which cog writes; a checkout from before the split or the rename of the gateway marker reads other markers, so update it"
        fi
    done
}

within() {
    local candidate=$1
    while [[ $candidate == /* ]]; do
        [[ -e $candidate && $candidate -ef $2 ]] && return 0
        [[ $candidate == / ]] && return 1
        candidate=${candidate%/*}
        candidate=${candidate:-/}
    done
    return 1
}

dest=
dest_count=0
dotfiles_arg=
have_dotfiles=0
while (($#)); do
    case $1 in
    -h | --help)
        printf '%s\n' "$usage"
        exit 0
        ;;
    --dotfiles)
        [[ $# -ge 2 && -n $2 ]] || die "--dotfiles needs a directory"
        ((! have_dotfiles)) || die "--dotfiles was given twice"
        dotfiles_arg=$2
        have_dotfiles=1
        shift 2
        ;;
    --dotfiles=*)
        ((! have_dotfiles)) || die "--dotfiles was given twice"
        dotfiles_arg=${1#--dotfiles=}
        [[ -n $dotfiles_arg ]] || die "--dotfiles needs a directory"
        have_dotfiles=1
        shift
        ;;
    *)
        dest=$1
        dest_count=$((dest_count + 1))
        shift
        ;;
    esac
done
[[ $dest_count -eq 1 ]] || die "$usage"
[[ -n $dest ]] || die "DEST is empty"
[[ $dest != -* ]] || die "DEST $dest starts with a dash; write ./$dest"

for tool in git tar gitleaks; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
done
unset CDPATH

cog_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -x $cog_root/tools/stage_tree.sh && -d $cog_root/guest && -d $cog_root/cloudflare/guest ]] ||
    die "$cog_root is not a cog checkout (tools/stage_tree.sh, guest/ or cloudflare/guest/ is missing)"

dotfiles=${dotfiles_arg:-$default_dotfiles}
[[ -d $dotfiles ]] || die "the dotfiles checkout $dotfiles does not exist; pass --dotfiles DIR"
dotfiles=$(CDPATH='' cd -- "$dotfiles" && pwd -P)
top=$(git -C "$dotfiles" rev-parse --show-toplevel 2>/dev/null) ||
    die "$dotfiles is not a git checkout; pass --dotfiles DIR"
[[ $top == "$dotfiles" ]] || die "$dotfiles is not the top level of its git checkout; pass --dotfiles DIR"
[[ -x $dotfiles/provision.sh && -f $dotfiles/.claude/settings.json && -f $dotfiles/tools/configure_codex.py ]] ||
    die "$dotfiles is not a dotfiles checkout (provision.sh, .claude/settings.json or tools/configure_codex.py is missing)"
commit=$(git -C "$dotfiles" rev-parse --verify HEAD 2>/dev/null) || die "$dotfiles has no commits"
printf 'context.sh: using the dotfiles checkout %s at %s\n' "$dotfiles" "$commit"

while [[ $dest == */ && $dest != / ]]; do
    dest=${dest%/}
done
[[ $dest != / ]] || die "refusing to use /"
[[ ! -L $dest ]] || die "DEST $dest is a symlink"
case $dest in
*/*)
    parent=${dest%/*}
    parent=${parent:-/}
    ;;
*) parent=. ;;
esac
parent=$(cd "$parent" 2>/dev/null && pwd -P) || die "the parent directory of $dest does not exist"
name=${dest##*/}
[[ $name != . && $name != .. ]] || die "DEST must not end in . or .."
if [[ $parent == / ]]; then
    dest=/$name
else
    dest=$parent/$name
fi
for checkout in "$cog_root" "$dotfiles"; do
    if within "$dest" "$checkout" || within "$checkout" "$dest"; then
        die "DEST $dest must be outside $checkout, and must not contain it"
    fi
done
dest_existed=0
if [[ -e $dest ]]; then
    [[ -d $dest ]] || die "DEST $dest exists and is not a directory"
    [[ -z $(ls -A "$dest") ]] || die "DEST $dest is not empty"
    dest_existed=1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/cog-context.XXXXXX")
finished=0
created=0
cleanup() {
    rm -rf "$work"
    if ((created && ! finished)); then
        if ((dest_existed)); then
            rm -rf "$dest/dotfiles" "$dest/guest" "$dest/cloudflare"
        else
            rm -rf "$dest"
        fi
    fi
}
trap cleanup EXIT

copy_tree() {
    local special
    COPYFILE_DISABLE=1 tar --no-xattrs --no-acls -C "$1" --exclude __pycache__ -cf - . |
        tar -xpf - --no-xattrs --no-acls --no-same-owner -C "$2"
    special=$(cd "$2" && find . ! -type f ! -type d)
    [[ -z $special ]] || die "${1#"$work/cog/"} may hold only regular files and directories: $special"
    # The Dockerfile copies the files into /usr/local/lib/cog with the modes they
    # have here, and the image's user must be able to read and run them whatever
    # the modes of the checkout were.
    chmod -R u=rwX,go=rX "$2"
}

"$cog_root/tools/stage_tree.sh" "$work/cog"
created=1
mkdir -p "$dest"
"$cog_root/tools/stage_tree.sh" --source "$dotfiles" "$dest/dotfiles"
check_marker_readers "$dest/dotfiles"
mkdir "$dest/guest" "$dest/cloudflare"
copy_tree "$work/cog/guest" "$dest/guest"
copy_tree "$work/cog/cloudflare/guest" "$dest/cloudflare"
for file in guest/throwaway.sh guest/reset-identity.sh guest/github-gateway-credential guest/configure-github-access.sh guest/install-push-instructions.sh cloudflare/entrypoint.sh; do
    [[ -f $dest/$file && -x $dest/$file ]] || die "$file is missing from the assembled context, or is not executable"
done

finished=1
printf 'context.sh: assembled %s\n' "$dest"
