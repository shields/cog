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
umask 022

die() {
    printf 'install.sh: %s\n' "$*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null || die "$1 is required; install the Homebrew formula $2"
}

unload() {
    if launchctl print "$service" >/dev/null 2>&1; then
        launchctl bootout "$service"
        # bootout returns before launchd releases the label.
        local attempt
        for ((attempt = 0; attempt < 100; ++attempt)); do
            if ! launchctl print "$service" >/dev/null 2>&1; then
                return 0
            fi
            sleep 0.1
        done
        die "timed out waiting for $label to unload"
    fi
}

case $#:${1:-} in
0: | 1:--uninstall) ;;
*) die "usage: install.sh [--uninstall]" ;;
esac
[[ $(uname -s) == Darwin ]] || die "macOS is required"
[[ ${HOME:-} == /* && ! $HOME =~ [[:cntrl:]] ]] || die "HOME must be an absolute path without control characters"
command -v launchctl >/dev/null || die "macOS launchctl is required"

label=dev.msrl.cog.gateway
domain=gui/$UID
service=$domain/$label
share=$HOME/.local/share/cog
binary=$share/cog
link=$HOME/bin/cog
plist=$HOME/Library/LaunchAgents/$label.plist
logs=$HOME/Library/Logs

[[ ! -L $share && ! -d $binary && ! -d $plist ]] || die "unexpected cog installation paths"
link_is_ours=0
if [[ -L $link && $(readlink "$link") == "$binary" ]]; then
    link_is_ours=1
fi

if [[ ${1:-} == --uninstall ]]; then
    unload
    if [[ $link_is_ours == 1 ]]; then
        rm -f "$link"
    fi
    rm -f "$plist" "$binary"
    if [[ -d $share ]]; then
        rmdir "$share"
    fi
    printf 'Kept %s\n' "$HOME/.local/state/cog" "$HOME/.config/secrets/cog" "$HOME/.config/cog" "$logs"
    exit 0
fi

[[ $link_is_ours == 1 || (! -e $link && ! -L $link) ]] || die "refusing to replace $link"
need bun bun
need limactl lima
need gitleaks gitleaks
need git git
need gh gh
need jq jq
need socat socat
need openssl openssl@3
command -v tar >/dev/null || die "macOS tar is required"
command -v plutil >/dev/null || die "macOS plutil is required"

checkout=$(
    unset CDPATH
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P
)
cd -- "$checkout"
bun install --frozen-lockfile </dev/null

mkdir -p "$share" "${link%/*}" "${plist%/*}" "$logs"
build_dir=
plist_dir=
trap '[[ -z $build_dir ]] || rm -rf "$build_dir"; [[ -z $plist_dir ]] || rm -rf "$plist_dir"' EXIT
build_dir=$(mktemp -d "$share/.build.XXXXXX")
plist_dir=$(mktemp -d "${plist%/*}/.cog.XXXXXX")
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    cog/main.ts --outfile "$build_dir/cog" </dev/null
[[ -f $build_dir/cog && -x $build_dir/cog ]] || die "Bun did not produce an executable"

xml_home=$(printf '%s' "$HOME" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")
cat >"$plist_dir/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$xml_home/.local/share/cog/cog</string>
        <string>gateway</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$xml_home/Library/Logs/$label.out</string>
    <key>StandardErrorPath</key>
    <string>$xml_home/Library/Logs/$label.err</string>
</dict>
</plist>
EOF
plutil -lint "$plist_dir/$label.plist" >/dev/null || die "the generated LaunchAgent plist is invalid"

unload
mv -f "$build_dir/cog" "$binary"
mv -f "$plist_dir/$label.plist" "$plist"
if [[ $link_is_ours == 0 ]]; then
    ln -s "$binary" "$link"
fi
launchctl bootstrap "$domain" "$plist"

unset COG_ROOT COG_BASE
for ((attempt = 0; attempt < 100; ++attempt)); do
    if "$binary" gateway health >/dev/null 2>&1 </dev/null; then
        printf 'Installed %s; the gateway is ready.\n' "$link"
        exit 0
    fi
    sleep 0.1
done
die "the gateway did not become healthy; see $logs/$label.err"
