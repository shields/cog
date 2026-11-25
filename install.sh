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

check_path() {
    [[ $1 == /* && ! $1 =~ [[:cntrl:]] ]] || die "$2 must be an absolute path without control characters"
}

real_dir() {
    local dir
    dir=$(cd -P -- "$1" 2>/dev/null && pwd -P && printf x) || die "cannot resolve the directory $1"
    dir=${dir%?x}
    check_path "$dir" "$1"
    printf '%s' "$dir"
}

# Seatbelt matches resolved paths, and the key file may be a link or may not
# exist yet, so a missing file keeps its name under its resolved parent.
real_file() {
    local path=$1 dir target hop
    for ((hop = 0; hop < 40; ++hop)); do
        dir=$(real_dir "${path%/*}/") || exit 1
        dir=${dir%/}
        path=$dir/${path##*/}
        [[ -L $path ]] || break
        target=$(readlink -n "$path" && printf x) || exit 1
        target=${target%x}
        [[ $target == /* ]] || target=$dir/$target
        path=$target
    done
    [[ $hop -lt 40 ]] || die "too many links in $1"
    dir=$(real_dir "${path%/*}/") || exit 1
    dir=${dir%/}
    [[ -n ${path##*/} && ${path##*/} != . && ${path##*/} != .. ]] || die "cannot resolve $1"
    path=$dir/${path##*/}
    check_path "$path" "$1"
    printf '%s' "$path"
}

private_dir() {
    [[ -d $1 ]] || (umask 077 && mkdir -p -- "$1") || die "cannot create $1"
}

xml() {
    printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

unload() {
    if launchctl print "$service" >/dev/null 2>&1; then
        # A signal or a failure from here on can leave no agent loaded, so
        # on_exit starts the previous one again. A successful unload leaves
        # stopping set for the caller to hand over to swapping.
        stopping=1
        launchctl bootout "$service"
        # bootout returns before launchd releases the label, which happens once
        # the gateway has finished its requests in flight, or ExitTimeOut later.
        local attempt
        for ((attempt = 0; attempt < (exit_timeout + 10) * 10; ++attempt)); do
            if ! launchctl print "$service" >/dev/null 2>&1; then
                return 0
            fi
            sleep 0.1
        done
        stopping=0
        die "timed out waiting for $label to unload"
    fi
}

wait_healthy() {
    local attempt
    for ((attempt = 0; attempt < 100; ++attempt)); do
        if "$binary" gateway health >/dev/null 2>&1 </dev/null; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

# The state is not restored: a daemon that ran may already have changed it.
# shellcheck disable=SC2329
roll_back() {
    set +e
    local problem='' file unloaded=1
    if [[ $had_previous == 0 ]]; then
        rm -f "$binary.previous" "$profile.previous" "$plist.previous"
        printf 'install.sh: %s; see %s\n' "$swap_failure" "$logs/$label.err" >&2
        return
    fi
    (unload) || unloaded=0
    [[ $unloaded == 1 ]] || problem="could not unload the agent"
    for file in "$binary" "$profile" "$plist"; do
        [[ -f $file.previous ]] || continue
        # A file that was not replaced is still the kept file, and mv leaves
        # both names in place when they are one file.
        if [[ $file -ef $file.previous ]]; then
            rm -f "$file.previous"
        elif ! mv -f "$file.previous" "$file"; then
            problem="${problem:+$problem; }could not restore $file"
        fi
    done
    if [[ $unloaded == 1 ]]; then
        unset COG_ROOT COG_BASE
        if ! launchctl bootstrap "$domain" "$plist"; then
            problem="${problem:+$problem; }could not bootstrap the previous agent"
        elif ! wait_healthy; then
            problem="${problem:+$problem; }the previous gateway did not become healthy"
        fi
    fi
    if [[ -z $problem ]]; then
        printf 'install.sh: %s; restored the previous gateway, which is healthy; see %s\n' \
            "$swap_failure" "$logs/$label.err" >&2
    else
        printf 'install.sh: %s; restoring the previous gateway also failed (%s); check %s, then run install.sh --uninstall and install again\n' \
            "$swap_failure" "$problem" "$logs/$label.err" >&2
    fi
}

# shellcheck disable=SC2329
on_exit() {
    local status=$?
    set +e
    trap '' HUP INT TERM
    if [[ $swapping == 1 || $stopping == 1 ]]; then
        swapping=0
        stopping=0
        roll_back
        status=1
    else
        rm -f "$binary.previous" "$profile.previous" "$plist.previous"
    fi
    [[ -z $build_dir ]] || rm -rf "$build_dir"
    [[ -z $plist_dir ]] || rm -rf "$plist_dir"
    exit "$status"
}

case $#:${1:-} in
0: | 1:--uninstall) ;;
*) die "usage: install.sh [--uninstall]" ;;
esac
[[ $(uname -s) == Darwin ]] || die "macOS is required"
[[ ${HOME:-} == /* && ! $HOME =~ [[:cntrl:]] ]] || die "HOME must be an absolute path without control characters"
command -v launchctl >/dev/null || die "macOS launchctl is required"

label=dev.msrl.cog.gateway
exit_timeout=60
domain=gui/$UID
service=$domain/$label
share=$HOME/.local/share/cog
binary=$share/cog
profile=$share/gateway.sb
link=$HOME/bin/cog
plist=$HOME/Library/LaunchAgents/$label.plist
logs=$HOME/Library/Logs

[[ ! -L $share && ! -d $binary && ! -d $plist && ! -d $profile ]] || die "unexpected cog installation paths"
link_is_ours=0
if [[ -L $link && $(readlink "$link") == "$binary" ]]; then
    link_is_ours=1
fi

if [[ ${1:-} == --uninstall ]]; then
    unload
    if [[ $link_is_ours == 1 ]]; then
        rm -f "$link"
    fi
    rm -f "$plist" "$binary" "$profile" "$plist.previous" "$binary.previous" "$profile.previous"
    # SIGKILL and SIGQUIT end the installer without its EXIT trap, which leaves
    # its staging directories.
    rm -rf "$share"/.build.?????? "${plist%/*}"/.cog.??????
    if [[ -d $share ]]; then
        rmdir "$share"
    fi
    printf 'Kept %s\n' "$HOME/.local/state/cog" "$HOME/.config/secrets/cog" "$HOME/.config/cog" "$logs"
    exit 0
fi

[[ ! -e $binary.previous && ! -e $profile.previous && ! -e $plist.previous ]] ||
    die "an earlier install was interrupted and left $binary.previous, $profile.previous or $plist.previous; run install.sh --uninstall, then install again"
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
sandbox_exec=$(command -v sandbox-exec) || die "macOS sandbox-exec is required"

checkout=$(
    unset CDPATH
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P
)
cd -- "$checkout"
bun install --frozen-lockfile </dev/null

mkdir -p "$share" "${link%/*}" "${plist%/*}" "$logs"
private_dir "$HOME/.local/state/cog"
private_dir "$HOME/.config/secrets/cog"
real_share=$(real_dir "$share")
real_state=$(real_dir "$HOME/.local/state/cog")
real_secrets=$(real_dir "$HOME/.config/secrets/cog")
real_key=$(real_file "$HOME/.config/secrets/FIREWORKS_API_KEY")
parameters=("STATE=$real_state" "SECRETS=$real_secrets" "FIREWORKS_KEY=$real_key")
build_dir=
plist_dir=
swapping=0
stopping=0
had_previous=0
swap_failure=
trap on_exit EXIT
trap 'swap_failure="the install was interrupted"; exit 1' HUP INT TERM
build_dir=$(mktemp -d "$share/.build.XXXXXX")
plist_dir=$(mktemp -d "${plist%/*}/.cog.XXXXXX")
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    cog/main.ts --outfile "$build_dir/cog" </dev/null
[[ -f $build_dir/cog && -x $build_dir/cog ]] || die "Bun did not produce an executable"

cat gateway/gateway.sb >"$build_dir/gateway.sb"
chmod 644 "$build_dir/gateway.sb"
real_build=$(real_dir "$build_dir")

xml_home=$(xml "$HOME")
xml_arguments="        <string>-D</string>
        <string>$(xml "BINARY=$real_share/cog")</string>
"
validate_arguments=(-f "$real_build/gateway.sb" -D "BINARY=$real_build/cog")
for parameter in "${parameters[@]}"; do
    xml_arguments+="        <string>-D</string>
        <string>$(xml "$parameter")</string>
"
    validate_arguments+=(-D "$parameter")
done
cat >"$plist_dir/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/sandbox-exec</string>
        <string>-f</string>
        <string>$(xml "$real_share/gateway.sb")</string>
${xml_arguments}        <string>$(xml "$real_share/cog")</string>
        <string>gateway</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>$exit_timeout</integer>
    <key>StandardOutPath</key>
    <string>$xml_home/Library/Logs/$label.out</string>
    <key>StandardErrorPath</key>
    <string>$xml_home/Library/Logs/$label.err</string>
</dict>
</plist>
EOF
plutil -lint "$plist_dir/$label.plist" >/dev/null || die "the generated LaunchAgent plist is invalid"

validation=$(
    cd / &&
        unset COG_ROOT COG_BASE &&
        PATH=/usr/bin:/bin:/usr/sbin:/sbin &&
        "$sandbox_exec" "${validate_arguments[@]}" "$real_build/cog" help 2>&1 </dev/null
) || die "cog does not run under the sandbox profile (status $?): $validation"

for file in "$binary" "$profile" "$plist"; do
    if [[ -f $file ]]; then
        ln -f "$file" "$file.previous"
    fi
done
[[ ! -f $plist ]] || had_previous=1
swap_failure="stopping the previous gateway failed"
unload
swapping=1
stopping=0
swap_failure="installing the new build failed"
mv -f "$build_dir/cog" "$binary"
mv -f "$build_dir/gateway.sb" "$profile"
mv -f "$plist_dir/$label.plist" "$plist"
if [[ $link_is_ours == 0 ]]; then
    ln -s "$binary" "$link"
fi
launchctl bootstrap "$domain" "$plist"

unset COG_ROOT COG_BASE
swap_failure="the new build did not become healthy"
if wait_healthy; then
    swapping=0
    rm -f "$binary.previous" "$profile.previous" "$plist.previous"
    printf 'Installed %s; the gateway is ready.\n' "$link"
    exit 0
fi
exit 1
