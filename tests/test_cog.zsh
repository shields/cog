#!/bin/zsh
#
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
zmodload zsh/stat

# A git hook's environment would aim the fixture's git at the hook's repository.
for var in $(git rev-parse --local-env-vars); do
    unset "$var"
done

# The caller's COG_CPUS or COG_MEMORY would change what cog passes to limactl;
# unset -m returns 1 when nothing matches.
unset -m 'COG_*' || true

HERE="${0:A:h}"
PYTHON="$(uv run --project "$HERE/.." python -c 'import sys; print(sys.executable)')"
export PATH="${PYTHON:h}:$PATH"
INSTALL="$HERE/../install.sh"
GATEWAY_STATE="$HERE/gateway_state.ts"
REAL_CURL="$(command -v curl)"
REAL_GIT="$(command -v git)"
REAL_GITLEAKS="$(command -v gitleaks)"
# The gateway refuses a Unix socket path over 100 bytes, which a macOS
# $TMPDIR-based directory exceeds once a VM's socket is under it.
TMPBASE="${$(mktemp -d /tmp/cog.XXXXXX):A}"
GATEWAY_PID=
stop_gateway() {
    if [[ -n $GATEWAY_PID ]]; then
        kill -TERM "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
        GATEWAY_PID=
    fi
}
coproc bun --no-env-file -e '
    const publicPaths = new Set(["/repos/shields/cog", "/repos/shields/dotfiles"]);
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (request.method !== "HEAD" || request.headers.has("authorization"))
                return new Response(null, {status: 400});
            if (path === "/repos/shields/unavailable")
                return new Response(null, {status: 503});
            return new Response(null, {status: publicPaths.has(path) ? 200 : 404});
        }
    });
    console.log(server.url.origin);
'
GITHUB_PID=$!
trap 'kill -TERM "$GITHUB_PID" 2>/dev/null || true; stop_gateway; rm -rf "$TMPBASE"' EXIT
read -rp GITHUB_API_URL
export TMPDIR="$TMPBASE/tmp"
mkdir -p "$TMPDIR"
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z

pass=0
fail=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "PASS: $desc"
        (( ++pass ))
    else
        echo "FAIL: $desc"
        echo "  expected: $expected"
        echo "  actual:   $actual"
        (( ++fail ))
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        echo "PASS: $desc"
        (( ++pass ))
    else
        echo "FAIL: $desc"
        echo "  missing:  $needle"
        echo "  in:       $haystack"
        (( ++fail ))
    fi
}

STUBS="$TMPBASE/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/record" <<'STUB'
record() {
    local record_name=${1##*/} record_file
    shift
    record_file=$(mktemp "$LIMA_STUB_STATE/calls/$record_name.XXXXXX")
    printf '%s\n' "$@" > "$record_file.argv"
    env | sort > "$record_file.env"
    if [[ ! -t 0 ]]; then
        cat > "$record_file.stdin"
        exec < "$record_file.stdin"
    fi
}
STUB

# limactl keeps its instances and its calls under $LIMA_STUB_STATE, a call whose
# arguments contain $LIMA_STUB_FAIL fails, and one whose arguments contain
# $LIMA_STUB_BLOCK creates $LIMA_STUB_STATE/blocked and waits for
# a terminal signal. A call to a subcommand named in
# $LIMA_STUB_SNAPSHOT saves the gateway's state to
# $LIMA_STUB_STATE/snapshots/CALL.json before it does anything.
cat > "$STUBS/limactl" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
printf '%s\n' "$*" >> "$state/limactl.log"
call=$(wc -l < "$state/limactl.log" | tr -d ' ')
printf '%s\n' "$@" > "$state/calls/$call.argv"
env | sort > "$state/calls/$call.env"
if [[ ! -t 0 ]]; then
    cat > "$state/calls/$call.stdin"
fi
if [[ " ${LIMA_STUB_SNAPSHOT:-} " == *" $1 "* ]]; then
    mkdir -p "$state/snapshots"
    bun --no-env-file "$GATEWAY_STATE" dump > "$state/snapshots/$call.json"
fi
if [[ -n ${LIMA_STUB_FAIL:-} && $* == *"$LIMA_STUB_FAIL"* ]]; then
    echo "limactl: injected failure" >&2
    exit 1
fi
if [[ -n ${LIMA_STUB_BLOCK:-} && $* == *"$LIMA_STUB_BLOCK"* ]]; then
    trap 'trap - HUP; kill -HUP "$$"' HUP
    trap 'trap - INT; kill -INT "$$"' INT
    trap 'trap - TERM; kill -TERM "$$"' TERM
    trap 'trap - QUIT; kill -QUIT "$$"' QUIT
    : > "$state/blocked"
    for _ in {1..400}; do
        /bin/sleep 0.05
    done
    echo 'limactl stub timed out waiting for a signal' >&2
    exit 91
fi
sub=$1
shift
case $sub in
list)
    case ${1:-} in
    -q)
        grep -qx -- "$2" "$state/instances" || exit 1
        echo "$2"
        ;;
    --format)
        case $2 in
        '{{.Protected}}') [[ -e "$state/protected-$3" ]] && echo true || echo false ;;
        '{{.Status}}') [[ -e "$state/stopped-$3" ]] && echo Stopped || echo Running ;;
        '{{.Dir}}') echo "$HOME/.lima/$3" ;;
        '{{len .Config.Mounts}}') cat "$state/mounts" 2>/dev/null || echo 0 ;;
        esac
        ;;
    *) cat "$state/instances" ;;
    esac
    ;;
start)
    while [[ $# -gt 0 ]]; do
        case $1 in
        --name=*) echo "${1#--name=}" >> "$state/instances" ;;
        --cpus | --memory) shift ;;
        --tty=false) ;;
        -*)
            echo "Error: unknown flag: $1" >&2
            exit 1
            ;;
        esac
        shift
    done
    ;;
clone)
    while [[ $# -gt 0 ]]; do
        case $1 in
        --cpus | --memory) shift ;;
        --tty=false | --start) ;;
        -*)
            echo "Error: unknown flag: $1" >&2
            exit 1
            ;;
        *) last=$1 ;;
        esac
        shift
    done
    echo "$last" >> "$state/instances"
    ;;
edit)
    while [[ $# -gt 0 ]]; do
        case $1 in
        --shell | --set) shift ;;
        --tty=false) ;;
        -*)
            echo "Error: unknown flag: $1" >&2
            exit 1
            ;;
        esac
        shift
    done
    ;;
delete)
    for last in "$@"; do :; done
    if [[ -e "$state/protected-$last" ]]; then
        echo "limactl: instance is protected" >&2
        exit 1
    fi
    grep -vx -- "$last" "$state/instances" > "$state/instances.new" || true
    mv "$state/instances.new" "$state/instances"
    ;;
protect) : > "$state/protected-$1" ;;
unprotect) rm -f "$state/protected-$1" ;;
shell)
    if [[ $1 == --workdir ]]; then
        shift 2
    fi
    shift
    case $* in
    'sh -c printf %s "$HOME"') [[ -e "$state/guest-home-unknown" ]] || printf '/home/guest' ;;
    'sh -c set -eu; rm -rf '*'tar -xf - '*)
        mkdir -p "$state/guest"
        tar -xf "$state/calls/$call.stdin" -C "$state/guest"
        ;;
    'sudo tar -x --no-same-owner --no-same-permissions -C '*)
        mkdir -p "$state/lib"
        tar -xf "$state/calls/$call.stdin" -C "$state/lib"
        ;;
    'env GIT_TERMINAL_PROMPT=0 git clone '*) ;;
    'git '*) git -C "$state/guest" "${@:2}" || exit $? ;;
    esac
    ;;
esac
exit 0
STUB

# gh answers the one read-only call cog makes, with the id in
# $LIMA_STUB_STATE/gh-id, and fails if $LIMA_STUB_STATE/gh-fail exists.
cat > "$STUBS/gh" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
source "$TEST_STUBS/record"
record "$0" "$@"
printf '%s\n' "$*" >> "$state/gh.log"
if [[ -e "$state/gh-fail" ]]; then
    echo "gh: HTTP 404: Not Found" >&2
    exit 1
fi
if [[ $* == "api repos/"*" --jq .id" ]]; then
    cat "$state/gh-id"
    exit 0
fi
echo "gh stub: unexpected call: $*" >&2
exit 2
STUB

# curl records its arguments and environment, so that the test can show that no
# secret reaches them, and then runs the real curl.
cat > "$STUBS/curl" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
source "$TEST_STUBS/record"
record "$0" "$@"

exec "$REAL_CURL" "$@"
STUB

cat > "$STUBS/open" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
printf '%s\n' "$*" >> "$LIMA_STUB_STATE/open.log"
[[ ! -e $LIMA_STUB_STATE/open-fail ]]
STUB

cat > "$STUBS/sleep" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
printf '%s\n' "$*" >> "$LIMA_STUB_STATE/sleep.log"
STUB

# cog has no use for the macOS security command, so any call is a failure.
cat > "$STUBS/security" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
echo "called: $*" >> "$LIMA_STUB_STATE/security.log"
echo "security: cog must not call this" >&2
exit 1
STUB
cat > "$STUBS/gitleaks" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
printf '%s\n' "$*" >> "$LIMA_STUB_STATE/gitleaks.log"
if [[ $1 == dir && -n ${GUEST_SCAN_FAIL:-} && ${@: -1} == */guest ]]; then
    echo "gitleaks: injected guest scan failure" >&2
    exit 1
fi
if [[ $1 == git && -n ${HISTORY_SCAN_FAIL:-} ]]; then
    echo "gitleaks: injected history scan failure" >&2
    exit 1
fi
exec "$REAL_GITLEAKS" "$@"
STUB
cat > "$STUBS/git" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
exec "$REAL_GIT" "$@"
STUB
chmod +x "$STUBS"/*

# stage_tree.sh records its arguments and the mode of the directory that holds
# its destination, fails if $STAGE_STUB_FAIL is set, and waits like limactl
# when $STAGE_STUB_BLOCK is set.
cat > "$TMPBASE/stage_tree.sh" <<'STUB'
#!/bin/bash
source "$TEST_STUBS/record"
record "$0" "$@"
printf '%s\n' "$@" > "$STAGE_ARGS_LOG"
perl -e 'printf "%o\n", (stat $ARGV[0])[2] & 07777' "$(dirname "${@: -1}")" > "$STAGE_ARGS_LOG.mode"
if [[ -n ${STAGE_STUB_BLOCK:-} ]]; then
    trap 'trap - HUP; kill -HUP "$$"' HUP
    trap 'trap - INT; kill -INT "$$"' INT
    trap 'trap - TERM; kill -TERM "$$"' TERM
    trap 'trap - QUIT; kill -QUIT "$$"' QUIT
    : > "$LIMA_STUB_STATE/blocked"
    for _ in {1..400}; do
        /bin/sleep 0.05
    done
    echo 'stager stub timed out waiting for a signal' >&2
    exit 91
fi
if [[ -n ${STAGE_STUB_FAIL:-} ]]; then
    echo "stage_tree: injected failure" >&2
    exit 1
fi
guest=${0%/embedded/tools/*}/guest
case ${TEST_GUEST_FAULT:-} in
    absent) rm -rf "$guest" ;;
    missing:*) rm "$guest/${TEST_GUEST_FAULT#*:}" ;;
    mode) chmod -x "$guest/setup-secrets" ;;
    secret) printf 'COG_GUEST_SENTINEL\n' > "$guest/planted" ;;
    symlink) ln -s absent "$guest/link" ;;
esac
STUB

BUILD="$TMPBASE/build"
COGTREE="$TMPBASE/installed"
COGBIN="$COGTREE/bin/cog"
mkdir -p "$BUILD/tools" "$COGTREE/bin"
cp -R "$HERE/../cog" "$HERE/../gateway" "$HERE/../lima" "$HERE/../guest" "$HERE/../profiles.yaml" "$BUILD/"
rm -rf "$BUILD/guest/__pycache__"
GUEST_FILES=$(cd "$BUILD/guest" && find . -type f | sort)
mkdir -p "$BUILD/guest/__pycache__"
: > "$BUILD/guest/__pycache__/github_app_token.cpython-313.pyc"
ln -s "$HERE/../node_modules" "$BUILD/node_modules"

# The shipping binary must not expose the test's staging fault injection.
{ print -r -- "$(<"$TMPBASE/stage_tree.sh")"; tail -n +2 "$HERE/../tools/stage_tree.sh"; } > "$BUILD/tools/stage_tree.sh"
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig "$BUILD/cog/main.ts" --outfile "$COGBIN"
rm -rf "$BUILD"

# The dotfiles checkout: each reader of a marker names it.
MARKER_READERS=(
    .zshrc:/etc/cog-throwaway
    .zshrc:/etc/cog-github-gateway
    .zshenv:/etc/cog-github-gateway
    .zsh.d/wt.zsh:/etc/cog-github-gateway
    .codex/hooks/git_guard.py:/etc/cog-github-gateway
    tools/configure_codex.py:/etc/cog-throwaway
    provision.sh:/etc/cog-github-gateway
)
DOTFILES="$TMPBASE/dotfiles"
mkdir -p "$DOTFILES/.claude" "$DOTFILES/.codex/hooks" "$DOTFILES/.zsh.d" "$DOTFILES/tools"
git -C "$DOTFILES" init -q -b main
printf '#!/bin/bash\n' > "$DOTFILES/provision.sh"
printf '{}\n' > "$DOTFILES/.claude/settings.json"
for entry in $MARKER_READERS; do
    print -r -- "# reads ${entry#*:}" >> "$DOTFILES/${entry%%:*}"
done
chmod +x "$DOTFILES/provision.sh"
git -C "$DOTFILES" add .
git -C "$DOTFILES" -c user.name=Test -c user.email=test@example.com commit -qm initial
git -C "$DOTFILES" tag initial
git -C "$DOTFILES" branch other
printf 'tracked\n' > "$DOTFILES/tracked.txt"
printf 'obsolete\n' > "$DOTFILES/obsolete.txt"
git -C "$DOTFILES" add .
git -C "$DOTFILES" -c user.name=Test -c user.email=test@example.com commit -qm second
git -C "$DOTFILES" remote add origin git@github.com:shields/dotfiles.git
mkdir -p "$TMPBASE/elsewhere"

GUEST_DIR=/home/guest/src/github.com/shields/dotfiles
OTHER_DIR=/home/guest/src/github.com/shields/other
FAKE_CLAUDE='sk-ant-oat01-FAKEclaudeToken-7f3c9a'
FAKE_CODEX='FAKE-codex-access-token-4c8e'
FAKE_FIREWORKS='fw_FAKEfireworksKey0123'
CODEX_JSON=$'{\n  "OPENAI_API_KEY": null,\n  "tokens": {\n    "access_token": "'"$FAKE_CODEX"$'",\n    "refresh_token": "FAKE-codex-refresh-9d1a"\n  }\n}\n'
# What the fake GitHub hands out, and the device code it expects back.
GITHUB_SECRETS=(-e ghu_fake-access -e ghr_fake-refresh -e fake-device-code)
GUEST_LIB=/usr/local/lib/cog

CASE_N=0
EXTRA_ENV=()

# The gateway's certificates are issued once, and each case starts from a copy.
CERTS_ROOT="$TMPBASE/certs"
COG_ROOT="$CERTS_ROOT" bun --no-env-file "$GATEWAY_STATE" certificates
CERTS="$CERTS_ROOT/secrets"

# new_case [INSTANCE...]: a fresh state with a home that holds a Codex login, a
# Claude token to type and the instances that exist, and a gateway root that
# nothing runs in yet (new_gateway_case does that).
new_case() {
    stop_gateway
    (( ++CASE_N ))
    STATE="$TMPBASE/s$CASE_N"
    HOME_DIR="$TMPBASE/h$CASE_N"
    GATEWAY_ROOT="$TMPBASE/r$CASE_N"
    mkdir -p "$STATE/calls" "$HOME_DIR/.codex"
    print -rn -- "$CODEX_JSON" > "$HOME_DIR/.codex/auth.json"
    : > "$STATE/instances"
    (( $# == 0 )) || printf '%s\n' "$@" >> "$STATE/instances"
    : > "$STATE/limactl.log"
    echo 4242 > "$STATE/gh-id"
    print -r -- "$FAKE_CLAUDE" > "$STATE/prompt"
    STAGE_ARGS_LOG="$STATE/stage-args"
        RUN_PATH=
    RUN_STDIN=
    RUN_COG=
    RUN_CWD=
    RUN_UMASK=022
    EXTRA_ENV=(COG_PROMPT_INPUT="$STATE/prompt")
}

gateway_state() {
    COG_ROOT="$GATEWAY_ROOT" bun --no-env-file "$GATEWAY_STATE" "$@"
}

# prepare_gateway: the gateway root has the suite's certificates, the profiles
# and authorizations, which hold fake tokens, for shields/dotfiles and
# shields/other.
prepare_gateway() {
    mkdir -p "$GATEWAY_ROOT/secrets"
    chmod 700 "$GATEWAY_ROOT/secrets"
    cp -p "$CERTS"/* "$GATEWAY_ROOT/secrets/"
    cp "$HERE/../profiles.yaml" "$GATEWAY_ROOT/profiles.yaml"
    gateway_state seed-auth shields/dotfiles shields/other
}

# start_gateway: prepare_gateway, then a daemon under the case's RUN_UMASK, with
# its output in $STATE/gateway.out and gateway.err.
start_gateway() {
    prepare_gateway
    local tries ready=0
    (
        umask "$RUN_UMASK"
        exec env -i PATH="$PATH" HOME="$HOME_DIR" TMPDIR="$TMPDIR" TEST_STUBS="$STUBS" \
            LIMA_STUB_STATE="$STATE" COG_ROOT="$GATEWAY_ROOT" "$COGBIN" gateway serve \
            > "$STATE/gateway.out" 2> "$STATE/gateway.err" < /dev/null
    ) &
    GATEWAY_PID=$!
    for tries in {1..400}; do
        if [[ -S "$GATEWAY_ROOT/state/admin.sock" ]] &&
            "$REAL_CURL" --silent --fail --max-time 5 --unix-socket "$GATEWAY_ROOT/state/admin.sock" http://localhost/health > /dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 0.05
    done
    if (( ! ready )); then
        echo "the gateway did not start: $(<"$STATE/gateway.err")" >&2
        exit 1
    fi
}

# new_gateway_case [INSTANCE...]: new_case with a gateway running.
new_gateway_case() {
    new_case "$@"
    start_gateway
}

# register_vm NAME: the gateway already has an active VM of that name, which
# its daemon does not know.
register_vm() {
    gateway_state register "lima:$1" "$HOME_DIR/.lima/$1/sock/github-registered.sock"
}

gateway_dump() {
    gateway_state dump
}

# instance_query NAME JQ: JQ applied to the gateway's newest record of the VM,
# which is null when it never registered.
instance_query() {
    gateway_dump | jq -c --arg name "lima:$1" "[.instances[] | select(.name == \$name)] | last | $2"
}

# unseed_auth OWNER/REPO: the Mac has no GitHub authorization for it.
unseed_auth() {
    rm -f "$GATEWAY_ROOT/secrets/$(printf %s "$1" | base64 | tr '+/' '-_' | tr -d '=').json"
}

# The checkout's origin must never lead a case to the real GitHub.
UNREACHABLE_GITHUB=http://127.0.0.1:9

# run_cog ARGS...: sets OUT (stdout and stderr) and RC. RUN_PATH replaces
# the stubbed PATH for one case, RUN_STDIN names a file to give cog on stdin
# instead of nothing, RUN_COG replaces the executable path, RUN_UMASK is its
# umask, and RUN_CWD is the current directory, the dotfiles checkout unless a
# case says otherwise (new reads its repository from there).
run_environment() {
    RUN_ENV=(PATH="${RUN_PATH:-$STUBS:$PATH}" HOME="$HOME_DIR" USER=shields TMPDIR="$TMPDIR"
        LIMA_STUB_STATE="$STATE" STAGE_ARGS_LOG="$STAGE_ARGS_LOG" TEST_STUBS="$STUBS" COG_BASE=test-base
        COG_ROOT="$GATEWAY_ROOT" GATEWAY_STATE="$GATEWAY_STATE"
        REAL_CURL="$REAL_CURL" REAL_GIT="$REAL_GIT" REAL_GITLEAKS="$REAL_GITLEAKS"
        NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 COG_GITHUB_WEB_URL="$UNREACHABLE_GITHUB"
        COG_GITHUB_API_URL="$GITHUB_API_URL"
        "${EXTRA_ENV[@]}")
    [[ -z ${RUN_WITHOUT_HOME:-} ]] || RUN_ENV=("${(@)RUN_ENV:#HOME=*}")
}

run_cog() {
    run_environment
    RC=0
    OUT="$(umask "$RUN_UMASK"; cd "${RUN_CWD:-$DOTFILES}" && env -i "${RUN_ENV[@]}" \
        "${RUN_COG:-$COGBIN}" "$@" 2>&1 <"${RUN_STDIN:-/dev/null}")" || RC=$?
}

# run_base ARGS...: cog base from a directory that is not a checkout, with the
# dotfiles checkout named, so that nothing is inferred from where it runs.
run_base() {
    local cwd=$RUN_CWD
    RUN_CWD="$TMPBASE/elsewhere"
    run_cog base --dotfiles "$DOTFILES" "$@"
    RUN_CWD=$cwd
}

# run_cog_signal [--dead-output] SIGNAL ARGS...: like run_cog, but SIGNAL (HUP,
# INT or TERM) reaches cog and everything it runs while a call is held (a
# limactl call that contains $LIMA_STUB_BLOCK in its arguments, or stage_tree.sh
# when $STAGE_STUB_BLOCK is set), as a terminal's signal reaches its foreground
# process group; nothing is left running when it returns. Closing a terminal
# sends HUP and nobody reads cog's output then, which --dead-output imitates
# with a pipe whose reader has gone. perl puts cog in a process group of its own
# and starts it with INT and QUIT at their defaults, since a background job
# otherwise ignores them. Sets OUT (empty with --dead-output) and RC, which is
# 128 plus the signal's number when the signal ends cog.
run_cog_signal() {
    local dead_output=0 signal pid tries
    if [[ ${1:-} == --dead-output ]]; then
        dead_output=1
        shift
    fi
    signal=$1
    shift
    run_environment
    rm -f "$STATE/blocked" "$STATE/signal.out"
    (
        umask "$RUN_UMASK"
        cd "${RUN_CWD:-$DOTFILES}"
        if (( dead_output )); then
            exec > >(:) 2>&1
        else
            exec > "$STATE/signal.out" 2>&1
        fi
        exec perl -e 'setpgrp(0, 0); $SIG{INT} = "DEFAULT"; $SIG{QUIT} = "DEFAULT"; exec @ARGV or die' -- \
            env -i "${RUN_ENV[@]}" "${RUN_COG:-$COGBIN}" "$@" < "${RUN_STDIN:-/dev/null}"
    ) &
    pid=$!
    for tries in {1..400}; do
        [[ -e "$STATE/blocked" ]] && break
        sleep 0.05
    done
    if [[ ! -e "$STATE/blocked" ]]; then
        kill -KILL "$pid" 2>/dev/null || true
        echo "no call was held for $signal: ${EXTRA_ENV[*]}" >&2
        exit 1
    fi
    kill -s "$signal" -- "-$pid"
    RC=0
    wait "$pid" || RC=$?
    OUT=
    [[ ! -e "$STATE/signal.out" ]] || OUT="$(<"$STATE/signal.out")"
}

# stdin_marker: a line that cog's own stdin holds for the case, so that a
# stub which reads it shows up; the stubs record what they are given.
STDIN_MARKER='cog-stdin-marker-9f3e'
stdin_marker() {
    RUN_STDIN="$STATE/stdin"
    print -r -- "$STDIN_MARKER" > "$RUN_STDIN"
}

calls_reading_stdin() {
    local recorded
    for recorded in "$STATE"/calls/*.stdin(N); do
        if grep -q -- "$STDIN_MARKER" "$recorded"; then
            print -r -- "${recorded:t}"
        fi
    done
    return 0
}

# The shell that new ends in is the one limactl call that may have cog's
# stdin; a lookup or a clone that read it would swallow what was meant for it.
assert_only_the_shell_reads_stdin() {
    assert_eq "only the final shell reads cog's stdin: $1" \
        "$(limactl_log | wc -l | tr -d ' ').stdin" "$(calls_reading_stdin)"
}

limactl_log() {
    sed -E "s|$TMPDIR/cog\\.[[:alnum:]]+/dev.yaml|COG/lima/dev.yaml|g; s|$COGTREE|COG|g; s|$DOTFILES|DOTFILES|g; s|$TMPBASE|TMP|g" "$STATE/limactl.log"
}

stdin_of() {
    cat "$STATE/calls/$1.stdin"
}

count_in_log() {
    grep -c -- "$1" "$STATE/limactl.log" || true
}

staging_dirs_left() {
    ls "$TMPDIR" | grep -c '^cog\.' || true
}

mode_of() {
    local -a mode
    zstat -A mode +mode "$1"
    printf '%o' $(( mode[1] & 8#7777 ))
}

# None of the secrets may show in what a stub was given as arguments or
# environment, in the logs of the stubs, in the gateway's state and output, or in
# what cog printed. They go over stdin and nowhere else. The gateway's own
# authorization records hold the fake GitHub tokens and are not scanned.
assert_no_secret_leak() {
    local desc="$1" leaks
    if [[ -e "$GATEWAY_ROOT/state/state.sqlite" ]]; then
        gateway_dump > "$STATE/dump.json"
    fi
    leaks="$(cat "$STATE"/calls/*.argv(N) "$STATE"/calls/*.env(N) "$STATE/limactl.log" "$STATE"/dump.json(N) \
        "$STATE"/gateway.out(N) "$STATE"/gateway.err(N) \
        "$STATE"/gh.log "$STATE"/open.log "$STATE"/sleep.log 2>/dev/null |
        grep -c -e "$FAKE_CLAUDE" -e "$FAKE_CODEX" -e "$FAKE_FIREWORKS" "${GITHUB_SECRETS[@]}" || true)"
    assert_eq "$desc: no secret in any recorded argv, environment or log" 0 "$leaks"
    assert_eq "$desc: no secret in cog's output" 0 \
        "$(printf '%s' "$OUT" | grep -c -e "$FAKE_CLAUDE" -e "$FAKE_CODEX" -e "$FAKE_FIREWORKS" "${GITHUB_SECRETS[@]}" || true)"
}

# --- 1. Static checks ---
assert_eq "no bash 4 constructs" "" \
    "$(grep -vE '^[[:space:]]*#' "$INSTALL" | grep -nE 'mapfile|readarray|declare +-A|local +-n|\$\{[A-Za-z_0-9]+(,,|\^\^|@[LUu])' || true)"
assert_eq "install.sh is run by the system bash" "#!/bin/bash" "$(head -1 "$INSTALL")"
assert_eq "no eval" "" \
    "$(grep -rEn '(^|[^[:alnum:]_])eval[ (]|new Function\(|Bun\.\$' "$HERE/../cog" "$HERE/../gateway" || true)"
assert_eq "cog is executable" yes "$([[ -x $COGBIN ]] && echo yes || echo no)"
assert_eq "cog does not use the Keychain" "" \
    "$(grep -rinE 'keychain|need security|find-generic-password' "$HERE/../cog" "$HERE/../gateway" || true)"

# --- 2. help and bad invocations ---
new_case
run_cog help
assert_eq "help succeeds" 0 "$RC"
assert_contains "help lists base" "cog base" "$OUT"
assert_contains "help lists new" "cog new" "$OUT"
assert_contains "help lists the grant command" "cog grant NAME [OWNER/REPO] [--profile read|cog]" "$OUT"
assert_contains "help names --repo" "--repo OWNER/REPO" "$OUT"
assert_contains "help names --no-repo" "--no-repo" "$OUT"
assert_contains "help names --no-claude-token" "--no-claude-token" "$OUT"
assert_contains "help names --no-codex-auth" "--no-codex-auth" "$OUT"
assert_contains "help says where Codex keeps its login" 'cli_auth_credentials_store = "file"' "$OUT"
assert_contains "help lists claude-token" "cog claude-token" "$OUT"
assert_contains "help names the Fireworks key file" ".config/secrets/FIREWORKS_API_KEY" "$OUT"
assert_contains "help describes the Mac gateway" "Credentials" "$OUT"
run_cog
assert_eq "no command fails" 2 "$RC"
RUN_WITHOUT_HOME=1 run_cog help
assert_eq "help without HOME fails" 1 "$RC"
assert_contains "help without HOME says so" "cog: HOME is not set" "$OUT"
run_cog frobnicate
assert_eq "unknown command fails" 2 "$RC"
run_cog new a b
assert_eq "new with two names fails" 1 "$RC"
run_cog list
assert_eq "list succeeds" 0 "$RC"
assert_eq "list is limactl list" "list" "$(limactl_log)"
expected_env="$(printf '%s\n' "${RUN_ENV[@]}" | LC_ALL=C sort)"
child_env="$(grep -Ev '^(PWD|OLDPWD|SHLVL|_)=|^BASH_FUNC_' "$STATE/calls/1.env")"
assert_eq "list passes its environment to limactl unchanged" "$expected_env" "$child_env"

# --- 3. base on a fresh machine ---
new_case
run_base none
assert_eq "base succeeds" 0 "$RC"
assert_eq "base call order" "list -q test-base
start --tty=false --name=test-base COG/lima/dev.yaml
list --format {{len .Config.Mounts}} test-base
shell test-base sh -c printf %s \"\$HOME\"
shell test-base sh -c set -eu; rm -rf \"\$1\"; mkdir -p \"\$1\"; tar -xf - --no-same-owner -C \"\$1\" _ $GUEST_DIR
shell test-base sudo install -d -m 755 -o root -g root $GUEST_LIB
shell test-base sudo tar -x --no-same-owner --no-same-permissions -C $GUEST_LIB
shell test-base sudo chown -R root:root $GUEST_LIB
shell test-base sudo chmod -R u=rwX,go=rX $GUEST_LIB
shell --workdir $GUEST_DIR test-base ./provision.sh none
shell --workdir $GUEST_DIR test-base git reset --mixed --quiet HEAD
shell test-base sudo $GUEST_LIB/throwaway.sh --claude-settings $GUEST_DIR/.claude/settings.json --no-github-timer
shell --workdir $GUEST_DIR test-base env PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin uv run --no-dev python tools/configure_codex.py /home/guest/.codex/config.toml
shell test-base sudo systemctl mask --now tailscaled.service
shell test-base sudo test ! -e /var/lib/tailscale/tailscaled.state
shell test-base sudo truncate -s 0 /etc/machine-id
shell test-base $GUEST_LIB/reset-identity.sh
stop --tty=false test-base
edit --tty=false test-base --shell /usr/bin/zsh
protect test-base" "$(limactl_log)"
assert_eq "base stages the dotfiles checkout into a directory outside it" 1 \
    "$([[ "$(<"$STAGE_ARGS_LOG")" == "--source"$'\n'"$DOTFILES"$'\n'"$TMPDIR"/cog.*/tree ]] && echo 1 || echo 0)"
assert_eq "base streams the staged tree as a tar archive" "./provision.sh" \
    "$(tar -tf "$STATE/calls/5.stdin" | grep -x './provision.sh')"
assert_eq "base removes its staging directory" 0 "$(staging_dirs_left)"
assert_eq "base leaves the VM protected" 1 "$([[ -e "$STATE/protected-test-base" ]] && echo 1 || echo 0)"
assert_contains "base says what to do next" "cog new" "$OUT"
assert_eq "base preserves the commit history" "$(git -C "$DOTFILES" log --format=%H)" \
    "$(git -C "$STATE/guest" log --format=%H 2>/dev/null || true)"
assert_eq "base preserves the branch" main "$(git -C "$STATE/guest" branch --show-current)"
assert_eq "base preserves tags" initial "$(git -C "$STATE/guest" tag)"
assert_eq "base copies other branches" "$(git -C "$DOTFILES" rev-parse other)" \
    "$(git -C "$STATE/guest" rev-parse refs/remotes/origin/other)"
assert_eq "base leaves a clean checkout clean" "" "$(git -C "$STATE/guest" status --porcelain)"
assert_eq "base uses HTTPS for the guest's GitHub origin" https://github.com/shields/dotfiles.git \
    "$(git -C "$STATE/guest" remote get-url origin 2>/dev/null || true)"

new_case
printf 'edited\n' > "$DOTFILES/tracked.txt"
printf 'untracked\n' > "$DOTFILES/new.txt"
rm "$DOTFILES/obsolete.txt"
run_base none
assert_eq "base with local changes succeeds" 0 "$RC"
assert_eq "base keeps local edits" edited "$(<"$STATE/guest/tracked.txt")"
assert_eq "base keeps untracked files" untracked "$(<"$STATE/guest/new.txt")"
assert_eq "base reports only the local changes" " D obsolete.txt
 M tracked.txt
?? new.txt" "$(git -C "$STATE/guest" status --porcelain)"
git -C "$DOTFILES" checkout -- tracked.txt obsolete.txt
rm "$DOTFILES/new.txt"

new_case
git -C "$DOTFILES" checkout -q --detach
run_base none
assert_eq "base with a detached HEAD succeeds" 0 "$RC"
assert_eq "base preserves a detached HEAD" "" "$(git -C "$STATE/guest" branch --show-current)"
assert_eq "base preserves the detached commit" "$(git -C "$DOTFILES" rev-parse HEAD)" \
    "$(git -C "$STATE/guest" rev-parse HEAD)"
git -C "$DOTFILES" checkout -q main

new_case
git -C "$DOTFILES" worktree add -q -b worktree "$TMPBASE/worktree"
MAIN_DOTFILES=$DOTFILES
DOTFILES="$TMPBASE/worktree"
printf 'worktree\n' > "$DOTFILES/tracked.txt"
run_base none
assert_eq "base from a linked worktree succeeds" 0 "$RC"
assert_eq "base preserves the worktree branch" worktree "$(git -C "$STATE/guest" branch --show-current)"
assert_eq "base preserves the worktree's changes" worktree "$(<"$STATE/guest/tracked.txt")"
assert_eq "the guest has an independent Git directory" yes "$([[ -d "$STATE/guest/.git" ]] && echo yes || echo no)"
assert_eq "the guest has no host object dependency" no "$([[ -e "$STATE/guest/.git/objects/info/alternates" ]] && echo yes || echo no)"
DOTFILES=$MAIN_DOTFILES

for origin in https://github.com/shields/dotfiles.git ssh://git@github.com/shields/dotfiles.git; do
    new_case
    git -C "$DOTFILES" remote set-url origin "$origin"
    run_base none
    assert_eq "base accepts a credential-free origin" 0 "$RC"
    assert_eq "base configures the HTTPS origin" https://github.com/shields/dotfiles.git \
        "$(git -C "$STATE/guest" remote get-url origin)"
done

origin_marker=COG_ORIGIN_CREDENTIAL
for origin in \
    "https://user:$origin_marker@github.com/shields/dotfiles.git" \
    "https://$origin_marker@github.com/shields/dotfiles.git" \
    "HTTPS://$origin_marker@github.com/shields/dotfiles.git" \
    "ssh://git:$origin_marker@github.com/shields/dotfiles.git" \
    "https://github.com/shields/dotfiles.git?token=$origin_marker" \
    "https://github.com/shields/dotfiles.git#$origin_marker" \
    $'https://github.com/shields/dotfiles.git\n'; do
    new_case test-base
    git -C "$DOTFILES" remote set-url origin "$origin"
    run_base none
    assert_eq "base rejects an origin that can carry credentials" 1 "$RC"
    assert_contains "base explains the origin rejection" "origin must not contain" "$OUT"
    assert_eq "a rejected origin touches no VM" "" "$(limactl_log)"
    assert_eq "origin credentials reach no command arguments or environment" no \
        "$(grep -Fq "$origin_marker" "$STATE"/calls/*.argv "$STATE"/calls/*.env && echo yes || echo no)"
    assert_eq "origin credentials are not printed" no "$([[ $OUT == *$origin_marker* ]] && echo yes || echo no)"
    assert_eq "a rejected origin leaves no staging directory" 0 "$(staging_dirs_left)"
done
git -C "$DOTFILES" remote set-url origin git@github.com:shields/dotfiles.git

new_history_case() {
    new_case test-base
    DOTFILES="$TMPBASE/history-$CASE_N"
    git clone -q --no-local "$MAIN_DOTFILES" "$DOTFILES"
    git -C "$DOTFILES" config user.name Test
    git -C "$DOTFILES" config user.email test@example.com
    git -C "$DOTFILES" remote set-url origin git@github.com:shields/dotfiles.git
    cat > "$STATE/gitleaks.toml" <<'EOF'
[[rules]]
id = "history-marker"
description = "Lima history regression marker"
regex = '''COG_HISTORY_SENTINEL'''
EOF
    EXTRA_ENV+=(GITLEAKS_CONFIG="$STATE/gitleaks.toml")
}

assert_history_rejected() {
    local desc=$1 filename=$2
    assert_eq "$desc fails base" 1 "$RC"
    assert_contains "$desc names the affected file" "$filename" "$OUT"
    assert_contains "$desc reports the history scan failure" "gitleaks found secrets in the repository history, or failed" "$OUT"
    assert_eq "$desc touches no VM" "" "$(limactl_log)"
    assert_eq "$desc leaves no staging directory" 0 "$(staging_dirs_left)"
    assert_eq "$desc is redacted" no "$([[ $OUT == *COG_HISTORY_SENTINEL* ]] && echo yes || echo no)"
}

new_history_case
git -C "$DOTFILES" checkout -qb merge-side
printf 'side\n' > "$DOTFILES/side.txt"
git -C "$DOTFILES" add side.txt
git -C "$DOTFILES" commit -qm side
git -C "$DOTFILES" checkout -q main
printf 'main\n' > "$DOTFILES/main.txt"
git -C "$DOTFILES" add main.txt
git -C "$DOTFILES" commit -qm main
git -C "$DOTFILES" merge --no-ff --no-commit merge-side >/dev/null 2>&1
printf 'COG_HISTORY_SENTINEL\n' > "$DOTFILES/merge-only.txt"
git -C "$DOTFILES" add merge-only.txt
git -C "$DOTFILES" commit -qm merge
git -C "$DOTFILES" rm -q merge-only.txt
git -C "$DOTFILES" commit -qm remove
run_base none
assert_history_rejected "a secret introduced only by a merge and then removed" merge-only.txt
DOTFILES=$MAIN_DOTFILES

new_history_case
git -C "$DOTFILES" checkout -qb unmerged
printf 'COG_HISTORY_SENTINEL\n' > "$DOTFILES/unmerged-only.txt"
git -C "$DOTFILES" add unmerged-only.txt
git -C "$DOTFILES" commit -qm unmerged
git -C "$DOTFILES" checkout -q main
git -C "$DOTFILES" remote remove origin
run_base none
assert_history_rejected "a secret on an unmerged branch with no origin" unmerged-only.txt
DOTFILES=$MAIN_DOTFILES

new_case
git -C "$DOTFILES" remote remove origin
run_base none
assert_eq "base accepts a safe repository without an origin" 0 "$RC"
assert_eq "a source without an origin leaves no host remote in the guest" "" "$(git -C "$STATE/guest" remote)"
assert_eq "base without an origin preserves history" "$(git -C "$DOTFILES" log --format=%H)" \
    "$(git -C "$STATE/guest" log --format=%H)"
git -C "$DOTFILES" remote add origin git@github.com:shields/dotfiles.git

# --- 4. base passes modules and sizes through ---
new_case
run_base dev data
assert_contains "base passes the modules" "./provision.sh dev data" "$(limactl_log)"
assert_eq "base without a size passes none" 0 "$(count_in_log '--cpus')"
new_case
EXTRA_ENV+=(COG_CPUS=4 COG_MEMORY=8)
run_base none
assert_contains "base passes the size to start" \
    "start --tty=false --name=test-base --cpus 4 --memory 8 COG/lima/dev.yaml" "$(limactl_log)"
new_case
EXTRA_ENV+=(COG_CPUS=many)
run_base none
assert_eq "a bad COG_CPUS fails" 1 "$RC"
assert_eq "a bad COG_CPUS touches no VM" "" "$(limactl_log)"
new_case
EXTRA_ENV+=(COG_MEMORY=8GiB)
run_base none
assert_eq "a bad COG_MEMORY fails" 1 "$RC"

# --- 5. base replaces an existing protected base ---
new_case test-base other
: > "$STATE/protected-test-base"
run_base none
assert_eq "base over a protected base succeeds" 0 "$RC"
assert_eq "base unprotects before deleting" "list -q test-base
list --format {{.Protected}} test-base
unprotect test-base
delete --tty=false --force test-base" "$(limactl_log | sed -n 1,4p)"
assert_eq "base leaves other VMs alone" 1 "$(grep -cx other "$STATE/instances")"

# --- 6. the dotfiles checkout comes from --dotfiles or the default, never from
# the current directory ---
new_case
run_cog base none
assert_eq "base run inside a dotfiles checkout, with no default one, fails" 1 "$RC"
assert_contains "base without a dotfiles checkout says where to pass one" "does not exist; pass --dotfiles DIR" "$OUT"
assert_eq "base without a dotfiles checkout touches no VM" "" "$(limactl_log)"
assert_eq "base without a dotfiles checkout stages nothing" 0 "$(staging_dirs_left)"

new_case
mkdir -p "$HOME_DIR/src/github.com/shields"
ln -s "$DOTFILES" "$HOME_DIR/src/github.com/shields/dotfiles"
RUN_CWD="$TMPBASE/elsewhere"
run_cog base none
assert_eq "base uses the default dotfiles checkout" 0 "$RC"
assert_contains "base names the default checkout and its commit" \
    "cog: building test-base from the dotfiles checkout $DOTFILES at $(git -C "$DOTFILES" rev-parse HEAD)" "$OUT"
assert_eq "base stages the default checkout" "--source"$'\n'"$DOTFILES" "$(head -2 "$STAGE_ARGS_LOG")"

new_case
RUN_CWD="$TMPBASE/elsewhere"
ln -sfn "$DOTFILES" "$TMPBASE/link-to-dotfiles"
run_cog base --dotfiles="$TMPBASE/link-to-dotfiles" none
assert_eq "base accepts --dotfiles=DIR" 0 "$RC"
assert_contains "base reports the canonical path of a symlinked checkout" \
    "from the dotfiles checkout $DOTFILES at " "$OUT"
assert_eq "base stages the canonical path" "--source"$'\n'"$DOTFILES" "$(head -2 "$STAGE_ARGS_LOG")"

new_case test-base
run_base none
assert_eq "base names the commit it builds from" 1 \
    "$([[ $OUT == *"cog: building test-base from the dotfiles checkout $DOTFILES at "*"$(git -C "$DOTFILES" rev-parse HEAD)"* ]] && echo 1 || echo 0)"

# A decoy in the current directory has a lima template, guest scripts and a
# staging script of its own; none of them may be used.
new_case
mkdir -p "$TMPBASE/hostile/lima" "$TMPBASE/hostile/guest" "$TMPBASE/hostile/tools"
: > "$TMPBASE/hostile/lima/dev.yaml"
printf '#!/bin/bash\ntouch "%s"\n' "$TMPBASE/hostile-ran" > "$TMPBASE/hostile/tools/stage_tree.sh"
chmod +x "$TMPBASE/hostile/tools/stage_tree.sh"
printf 'COG_CPUS=hostile\n' > "$TMPBASE/hostile/.env"
printf 'preload = ["./preload.ts"]\n' > "$TMPBASE/hostile/bunfig.toml"
printf 'await Bun.write("preload-ran", "yes");\n' > "$TMPBASE/hostile/preload.ts"
RUN_CWD="$TMPBASE/hostile"
run_cog base --dotfiles "$DOTFILES" none
assert_eq "base run beside a decoy succeeds" 0 "$RC"
assert_contains "base starts the embedded template, not the current directory's" \
    "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
assert_eq "base does not run the current directory's staging script" no "$([[ -e $TMPBASE/hostile-ran ]] && echo yes || echo no)"
assert_eq "base ignores a preload in the current directory" no "$([[ -e "$RUN_CWD/preload-ran" ]] && echo yes || echo no)"

new_case
mkdir -p "$TMPBASE/linkbin" "$TMPBASE/linkbin-relative"
ln -sfn "$COGBIN" "$TMPBASE/linkbin/cog"
ln -sfn ../installed/bin/cog "$TMPBASE/linkbin-relative/cog"
for RUN_COG in "$TMPBASE/linkbin/cog" "$TMPBASE/linkbin-relative/cog"; do
    : > "$STATE/limactl.log"
    run_base none
    assert_eq "base through a link to cog succeeds" 0 "$RC"
    assert_contains "base through a link uses the embedded template" \
        "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
done
RUN_COG=

new_case
mkdir -p "$TMPBASE/linkparent/lima" "$TMPBASE/linkparent/guest" "$TMPBASE/linkparent/tools"
: > "$TMPBASE/linkparent/lima/dev.yaml"
cp "$HERE/../tools/stage_tree.sh" "$TMPBASE/linkparent/tools/stage_tree.sh"
ln -sfn "$COGTREE/bin" "$TMPBASE/linkparent/bin-link"
ln -sfn ../installed/bin "$TMPBASE/linkparent/bin-link-relative"
for RUN_COG in "$TMPBASE/linkparent/bin-link/cog" "$TMPBASE/linkparent/bin-link-relative/cog"; do
    : > "$STATE/limactl.log"
    run_base none
    assert_eq "base through a link to cog's bin directory succeeds" 0 "$RC"
    assert_contains "base through a link to cog's bin directory uses the embedded template" \
        "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
done
RUN_COG=

# A CDPATH makes cd look elsewhere first and print where it went, which would
# end up in the paths that cog captures; it must not matter.
new_case
RUN_COG=bin/cog
RUN_CWD="$COGTREE"
EXTRA_ENV+=(CDPATH=.)
run_cog base --dotfiles "$DOTFILES" none
assert_eq "base run as bin/cog with CDPATH=. succeeds" 0 "$RC"
assert_contains "base run as bin/cog with CDPATH=. uses the embedded template" \
    "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
RUN_COG=

new_case
mkdir -p "$TMPBASE/cdpath-decoy/dotfiles"
RUN_CWD="$TMPBASE"
EXTRA_ENV+=(CDPATH="$TMPBASE/cdpath-decoy")
run_cog base --dotfiles dotfiles none
assert_eq "base with a relative --dotfiles and a CDPATH that holds the same name succeeds" 0 "$RC"
assert_contains "base takes the relative --dotfiles from the current directory" \
    "from the dotfiles checkout $DOTFILES at " "$OUT"

run_base_with_guest_fault() {
    EXTRA_ENV+=(TEST_GUEST_FAULT="$1")
    run_base none
}

new_case
run_base_with_guest_fault absent
assert_eq "a staged tree without guest scripts fails base" 1 "$RC"
assert_contains "it names the missing guest directory" "guest/" "$OUT"
assert_eq "it touches no VM" "" "$(limactl_log)"
RUN_COG=

for guest_script in github-gateway-credential reset-identity.sh setup-github-gateway setup-secrets throwaway.sh; do
    new_case test-base
    run_base_with_guest_fault "missing:$guest_script"
    assert_eq "a staged tree without guest/$guest_script fails base" 1 "$RC"
    assert_contains "base names the missing guest/$guest_script" "guest/$guest_script is missing" "$OUT"
    assert_eq "a missing guest/$guest_script touches no VM" "" "$(limactl_log)"
    assert_eq "a missing guest/$guest_script leaves the existing base" 1 "$(grep -cx test-base "$STATE/instances")"
    assert_eq "a missing guest/$guest_script leaves no staging directory" 0 "$(staging_dirs_left)"
done
new_case test-base
run_base_with_guest_fault mode
assert_eq "a guest script that is not executable fails base" 1 "$RC"
assert_contains "base names the guest script that is not executable" "guest/setup-secrets is missing" "$OUT"
assert_eq "a guest script that is not executable touches no VM" "" "$(limactl_log)"
RUN_COG=

new_case
run_cog base --dotfiles
assert_eq "--dotfiles without a directory fails" 1 "$RC"
assert_contains "--dotfiles without a directory says so" "--dotfiles needs a directory" "$OUT"
run_cog base --dotfiles=
assert_eq "an empty --dotfiles= fails" 1 "$RC"
run_cog base --dotfiles "$DOTFILES" --dotfiles "$DOTFILES"
assert_eq "--dotfiles twice fails" 1 "$RC"
assert_contains "--dotfiles twice says so" "given twice" "$OUT"
run_cog base --bogus
assert_eq "an unknown base option fails" 1 "$RC"
assert_contains "an unknown base option is named" "unknown option --bogus" "$OUT"
assert_eq "bad base options touch no VM" "" "$(limactl_log)"

# Options belong before the modules: everything from the first module on goes to
# provision.sh in the guest, which has no --dotfiles, after the existing base is
# gone. The default checkout exists here, so that a misplaced --dotfiles would
# otherwise start a build from it.
new_case test-base
mkdir -p "$HOME_DIR/src/github.com/shields"
ln -s "$DOTFILES" "$HOME_DIR/src/github.com/shields/dotfiles"
run_cog base none --dotfiles "$TMPBASE/elsewhere"
assert_eq "--dotfiles after a module fails" 1 "$RC"
assert_contains "--dotfiles after a module is named" "option --dotfiles must come before the modules" "$OUT"
assert_eq "--dotfiles after a module touches no VM" "" "$(limactl_log)"
assert_eq "--dotfiles after a module leaves the existing base" 1 "$(grep -cx test-base "$STATE/instances")"
assert_eq "--dotfiles after a module stages nothing" 0 "$(staging_dirs_left)"
run_cog base dev --dotfiles="$TMPBASE/elsewhere"
assert_eq "--dotfiles=DIR after a module fails" 1 "$RC"
run_cog base none --bogus
assert_eq "an unknown option after a module fails" 1 "$RC"
assert_contains "an unknown option after a module is named" "option --bogus must come before the modules" "$OUT"
assert_eq "options after a module touch no VM" "" "$(limactl_log)"

# dotfiles_copy NAME [FILE...]: a copy of the dotfiles checkout, with FILE
# paths removed from it.
dotfiles_copy() {
    local name=$1 file
    shift
    cp -R "$DOTFILES" "$TMPBASE/$name"
    for file in "$@"; do
        rm -rf "$TMPBASE/$name/$file"
    done
}

refuse_dotfiles() {
    local desc=$1 dir=$2 text=$3
    new_case test-base
    run_cog base --dotfiles "$dir" none
    assert_eq "$desc fails base" 1 "$RC"
    assert_contains "$desc says why" "$text" "$OUT"
    assert_eq "$desc touches no VM" "" "$(limactl_log)"
    assert_eq "$desc leaves the existing base" 1 "$(grep -cx test-base "$STATE/instances")"
    assert_eq "$desc leaves no staging directory" 0 "$(staging_dirs_left)"
}

mkdir "$TMPBASE/not-a-repository"
refuse_dotfiles "a missing directory" "$TMPBASE/missing" "does not exist"
refuse_dotfiles "a directory that is not a git checkout" "$TMPBASE/not-a-repository" "is not a git checkout"
refuse_dotfiles "a subdirectory of a checkout" "$DOTFILES/tools" "is not the top level"
dotfiles_copy no-provision provision.sh
refuse_dotfiles "a checkout without provision.sh" "$TMPBASE/no-provision" "is not a dotfiles checkout"
dotfiles_copy not-executable
chmod -x "$TMPBASE/not-executable/provision.sh"
refuse_dotfiles "a checkout whose provision.sh is not executable" "$TMPBASE/not-executable" "is not a dotfiles checkout"
dotfiles_copy no-settings .claude/settings.json
refuse_dotfiles "a checkout without .claude/settings.json" "$TMPBASE/no-settings" "is not a dotfiles checkout"
dotfiles_copy no-codex tools/configure_codex.py
refuse_dotfiles "a checkout without tools/configure_codex.py" "$TMPBASE/no-codex" "is not a dotfiles checkout"

# A checkout whose readers name other markers is refused; the check is on the
# staged tree, and it comes before anything is created or deleted.
for entry in $MARKER_READERS; do
    reader=${entry%%:*}
    marker=${entry#*:}
    dotfiles_copy "stale-${reader//\//-}-${marker:t}"
    MARKER=$marker perl -pi -e 's/\Q$ENV{MARKER}\E/\/etc\/stale-marker/g' "$TMPBASE/stale-${reader//\//-}-${marker:t}/$reader"
    refuse_dotfiles "$reader without $marker" "$TMPBASE/stale-${reader//\//-}-${marker:t}" \
        "$reader in the dotfiles checkout does not name $marker"
    assert_eq "$reader without $marker is reported after staging" 1 "$([[ -s $STAGE_ARGS_LOG ]] && echo 1 || echo 0)"
done
dotfiles_copy no-reader .zsh.d/wt.zsh
refuse_dotfiles "a missing marker reader" "$TMPBASE/no-reader" ".zsh.d/wt.zsh in the dotfiles checkout does not name"
dotfiles_copy pre-split
for entry in $MARKER_READERS; do
    MARKER=${entry#*:} perl -pi -e 's/\Q$ENV{MARKER}\E/\/etc\/dotfiles-throwaway/g' "$TMPBASE/pre-split/${entry%%:*}"
done
refuse_dotfiles "a checkout from before the split" "$TMPBASE/pre-split" "reads other markers"

# --- 6b. guest scripts install root-owned in /usr/local/lib/cog ---
new_case
run_base none
assert_eq "base sends the guest scripts as a tar archive" "$GUEST_FILES" \
    "$(tar -tf "$STATE/calls/7.stdin" | grep -v '/$' | sort)"
assert_eq "base unpacks the guest scripts with sudo tar in the guest" "$GUEST_FILES" \
    "$(cd "$STATE/lib" && find . -type f | sort)"
assert_eq "the unpacking call is sudo tar with the owner and permission flags" \
    "shell"$'\n'"test-base"$'\n'"sudo"$'\n'"tar"$'\n'"-x"$'\n'"--no-same-owner"$'\n'"--no-same-permissions"$'\n'"-C"$'\n'"$GUEST_LIB" \
    "$(<"$STATE/calls/7.argv")"
assert_eq "ownership is set after unpacking" "shell"$'\n'"test-base"$'\n'"sudo"$'\n'"chown"$'\n'"-R"$'\n'"root:root"$'\n'"$GUEST_LIB" \
    "$(<"$STATE/calls/8.argv")"
assert_eq "modes are set after ownership, whatever the umask of sudo tar" "shell"$'\n'"test-base"$'\n'"sudo"$'\n'"chmod"$'\n'"-R"$'\n'"u=rwX,go=rX"$'\n'"$GUEST_LIB" \
    "$(<"$STATE/calls/9.argv")"
guest_listing="$(tar -tvf "$STATE/calls/7.stdin")"
assert_eq "the guest scripts keep their executable bits in the archive" "yes" \
    "$(grep -q '^-rwx.* ./throwaway.sh$' <<<"$guest_listing" && echo yes || echo no)"
assert_eq "base leaves no bytecode cache in the guest scripts" 0 "$(find "$STATE/lib" -name __pycache__ | wc -l | tr -d ' ')"
assert_eq "base scans the guest scripts with gitleaks dir" 1 \
    "$(grep -cE "^dir .* $TMPDIR/cog\\.[A-Za-z0-9]+/guest\$" "$STATE/gitleaks.log" || true)"
assert_eq "no limactl call refers to the home directory's bin" 0 "$(grep -cE '/bin/setup-|HOME/bin|/home/guest/bin' "$STATE/limactl.log" || true)"

new_case test-base
EXTRA_ENV+=(GUEST_SCAN_FAIL=1)
run_base none
assert_eq "a failed guest scan fails base" 1 "$RC"
assert_contains "a failed guest scan says why" "gitleaks found secrets in guest/, or failed" "$OUT"
assert_eq "a failed guest scan touches no VM" "" "$(limactl_log)"
assert_eq "a failed guest scan leaves the existing base" 1 "$(grep -cx test-base "$STATE/instances")"
assert_eq "a failed guest scan leaves no staging directory" 0 "$(staging_dirs_left)"

new_case test-base
cat > "$STATE/gitleaks.toml" <<'EOF'
[[rules]]
id = "guest-marker"
description = "guest script regression marker"
regex = '''COG_GUEST_SENTINEL'''
EOF
EXTRA_ENV+=(GITLEAKS_CONFIG="$STATE/gitleaks.toml")
run_base_with_guest_fault secret
assert_eq "a planted secret in guest/ fails base" 1 "$RC"
assert_contains "a planted secret in guest/ names the file" planted "$OUT"
assert_eq "a planted secret in guest/ is redacted" no "$([[ $OUT == *COG_GUEST_SENTINEL* ]] && echo yes || echo no)"
assert_eq "a planted secret in guest/ touches no VM" "" "$(limactl_log)"
assert_eq "a planted secret in guest/ leaves no staging directory" 0 "$(staging_dirs_left)"

new_case test-base
run_base_with_guest_fault symlink
assert_eq "a symlink in guest/ fails base" 1 "$RC"
assert_contains "a symlink in guest/ says why" "only regular files and directories" "$OUT"
assert_eq "a symlink in guest/ touches no VM" "" "$(limactl_log)"

assert_eq "nothing refers to the home directory's bin" "" \
    "$(grep -rnIE '\$HOME/bin|~/bin|/home/shields/bin|guest_home/bin' "$HERE/../guest" "$HERE/../cloudflare/guest" "$HERE/../cog/commands" || true)"
assert_eq "the image's credential helper is the root-owned one" 1 \
    "$(grep -c '^helper=/usr/local/lib/cog/github-gateway-credential$' "$HERE/../cloudflare/guest/agent.sh" || true)"
assert_eq "the gateway setup finds its helper beside itself" 2 \
    "$(grep -c 'lib_dir/github-gateway-credential' "$HERE/../guest/setup-github-gateway" || true)"

# --- 7. base failures ---
new_case
EXTRA_ENV+=(STAGE_STUB_FAIL=1)
run_base none
assert_eq "a staging failure fails base" 1 "$RC"
assert_eq "a staging failure starts no VM" "" "$(limactl_log)"
assert_eq "a staging failure removes the staging directory" 0 "$(staging_dirs_left)"

new_case test-base
EXTRA_ENV+=(HISTORY_SCAN_FAIL=1)
run_base none
assert_eq "a history scan failure fails base" 1 "$RC"
assert_eq "a history scan failure touches no VM" "" "$(limactl_log)"
assert_eq "a history scan failure removes the staging directory" 0 "$(staging_dirs_left)"
assert_contains "a history scan failure says why" "gitleaks found secrets in the repository history, or failed" "$OUT"

new_case
echo 3 > "$STATE/mounts"
run_base none
assert_eq "a mounted base fails" 1 "$RC"
assert_contains "a mounted base says why" "mounts 3 host directories" "$OUT"
assert_eq "a mounted base runs no provisioning" 0 "$(count_in_log provision)"

new_case
EXTRA_ENV+=(LIMA_STUB_FAIL=./provision.sh)
run_base none
assert_eq "a provisioning failure fails base" 1 "$RC"
assert_eq "a provisioning failure stops before the identity reset and the protection" 0 \
    "$(grep -cE 'machine-id|reset-identity|protect|stop' "$STATE/limactl.log" || true)"
assert_contains "a provisioning failure keeps the VM for inspection" "left for inspection" "$OUT"
assert_eq "a provisioning failure keeps the VM" 1 "$(grep -cx test-base "$STATE/instances")"
assert_eq "a provisioning failure removes the staging directory" 0 "$(staging_dirs_left)"

new_case
: > "$STATE/guest-home-unknown"
run_base none
assert_eq "an unknown guest home fails base" 1 "$RC"
assert_contains "an unknown guest home in base says so" "cannot tell the home directory in test-base" "$OUT"
assert_eq "an unknown guest home in base runs no provisioning" 0 "$(count_in_log provision)"
assert_contains "an unknown guest home in base keeps the VM for inspection" "left for inspection" "$OUT"
assert_eq "an unknown guest home in base removes the staging directory" 0 "$(staging_dirs_left)"

# --- 8. new ---
new_gateway_case test-base
EXTRA_ENV+=(LIMA_STUB_SNAPSHOT=start)
stdin_marker
run_cog new t1 --repo shields/dotfiles
assert_eq "new with a repository succeeds" 0 "$RC"
vm_id="$(instance_query t1 .id | tr -d '"')"
assert_eq "the gateway registered the VM under an ID of its own" 1 \
    "$([[ $vm_id =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] && echo 1 || echo 0)"
assert_eq "new registers the VM as active, with a socket in its Lima directory" 1 \
    "$([[ "$(instance_query t1 .socket | tr -d '"')" == "$HOME_DIR/.lima/t1/sock/github-"*.sock ]] && echo 1 || echo 0)"
assert_eq "new registers exactly one VM" 1 "$(gateway_dump | jq '.instances | length')"
assert_eq "new leaves the VM active at its registration revision" '{"disabled":false,"revision":0}' \
    "$(instance_query t1 '{disabled, revision}')"
assert_contains "new installs reverse socket forwarding to the registered socket" \
    "guestSocket\":\"/tmp/cog-github.sock\",\"hostSocket\":\"{{.Dir}}/sock/$(instance_query t1 .socket | tr -d '"' | xargs basename)\",\"reverse\":true" \
    "$(<"$STATE/limactl.log")"
assert_contains "new starts the VM after configuring its socket" "edit --tty=false --set" "$(<"$STATE/limactl.log")"
start_call=$(grep -n '^start --tty=false t1$' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the VM is registered before it starts" "$vm_id" "$(jq -r '.instances[0].id' "$STATE/snapshots/$start_call.json")"
assert_contains "new installs guest trust and relay for the registered ID" "setup-github-gateway $vm_id" "$(<"$STATE/limactl.log")"
assert_contains "new runs the gateway setup from the root-owned directory" \
    "shell t1 sudo $GUEST_LIB/setup-github-gateway $vm_id" "$(<"$STATE/limactl.log")"
assert_contains "new installs the Claude token with the root-owned setup-secrets" \
    "shell t1 $GUEST_LIB/setup-secrets CLAUDE_CODE_OAUTH_TOKEN" "$(<"$STATE/limactl.log")"
assert_contains "new installs the Codex login with the root-owned setup-secrets" \
    "shell t1 $GUEST_LIB/setup-secrets CODEX_AUTH" "$(<"$STATE/limactl.log")"
assert_eq "new refers to nothing in the home directory's bin" 0 "$(grep -cE '/bin/setup-|HOME/bin|/home/guest/bin' "$STATE/limactl.log" || true)"
assert_contains "new probes the guest relay" "/__cog__/health" "$(<"$STATE/limactl.log")"
assert_eq "a cached authorization gives the new VM no grant for a public repo" '{}' "$(instance_query t1 .grants)"
assert_eq "new records only the registration event" \
    '[{"oldRevision":0,"newRevision":0,"changes":{"registered":true}}]' \
    "$(instance_query t1 .events)"
assert_eq "new sends no GitHub authorization to the guest" 0 "$(count_in_log GITHUB_APP_AUTH)"
assert_eq "new reuses the base checkout" 0 "$(count_in_log 'git clone')"
assert_contains "new opens the repository shell" "shell --workdir $GUEST_DIR t1" "$(<"$STATE/limactl.log")"
gateway_call=$(grep -n 'setup-github-gateway' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the guest receives only the gateway CA, the one the gateway issued" "$(<"$GATEWAY_ROOT/secrets/ca.pem")" "$(stdin_of "$gateway_call")"
claude_call=$(grep -n 'CLAUDE_CODE_OAUTH_TOKEN' "$STATE/limactl.log" | head -1 | cut -d: -f1)
codex_call=$(grep -n 'CODEX_AUTH' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the Claude token reaches only setup-secrets stdin" "$FAKE_CLAUDE" "$(stdin_of "$claude_call")"
assert_eq "the Codex login reaches only setup-secrets stdin" "${CODEX_JSON%$'\n'}" "$(stdin_of "$codex_call")"
assert_no_secret_leak "new with a repository"
assert_eq "a successful new leaves the gateway access enabled" false "$(instance_query t1 .disabled)"
assert_eq "a successful new deletes no VM" 0 "$(count_in_log delete)"
assert_eq "a successful new leaves the daemon silent" "" "$(<"$STATE/gateway.err")"
assert_only_the_shell_reads_stdin "new with a repository"

# The Mac holds no authorization for the repository, and the gh stub cannot read
# it: new stops at the authorization, before it creates anything.
new_gateway_case test-base
unseed_auth shields/other
: > "$STATE/gh-fail"
run_cog new t1 --repo shields/other
assert_eq "a repository without an authorization stops new" 1 "$RC"
assert_contains "new asked gh to read the repository" "api repos/shields/other --jq .id" "$(<"$STATE/gh.log")"
assert_contains "new says gh could not read it" "gh cannot read shields/other" "$OUT"
assert_eq "authorization comes before the clone" 0 "$(count_in_log clone)"
assert_eq "an unauthorized repository registers no VM" 0 "$(gateway_dump | jq '.instances | length')"
assert_eq "an unauthorized repository deletes no VM" 0 "$(count_in_log delete)"
assert_no_secret_leak "new with an unauthorized repository"

# An authorization whose refresh token has expired counts as none.
new_gateway_case test-base
gateway_state seed-expired shields/other
: > "$STATE/gh-fail"
run_cog new t1 --repo shields/other
assert_eq "an expired authorization stops new" 1 "$RC"
assert_contains "new asked gh to read the repository again" "api repos/shields/other --jq .id" "$(<"$STATE/gh.log")"
assert_eq "an expired authorization comes before the clone" 0 "$(count_in_log clone)"

new_gateway_case test-base
print -rl -- 'read: {read: true, pushCogBranches: true}' 'cog: {read: true, pushCogBranches: true}' > "$STATE/profiles.yaml"
EXTRA_ENV+=(COG_PROFILES="$STATE/profiles.yaml")
run_cog new t1 --repo shields/other
assert_eq "new clones a private repository with a read-only grant" 0 "$RC"
assert_eq "a custom profile cannot give a new VM push access" \
    '{"shields/other":{"read":true,"pushCogBranches":false}}' "$(instance_query t1 .grants)"
assert_contains "new verifies the private repository grant" "https://api.github.com/repos/shields/other" "$(<"$STATE/limactl.log")"
assert_contains "new opens the private repository shell" "shell --workdir $OTHER_DIR t1" "$(<"$STATE/limactl.log")"

new_gateway_case test-base
stdin_marker
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "new without a repository succeeds" 0 "$RC"
assert_eq "new without a repository registers the VM with no grant" '{"disabled":false,"grants":{}}' "$(instance_query t1 '{disabled, grants}')"
assert_eq "new without a repository still installs the gateway" 1 "$(count_in_log setup-github-gateway)"
assert_only_the_shell_reads_stdin "new without a repository"
assert_eq "new without a repository sends no GitHub secret" 0 "$(count_in_log GITHUB_APP_AUTH)"
assert_eq "--no-claude-token skips the Claude secret" 0 "$(count_in_log CLAUDE_CODE_OAUTH_TOKEN)"
assert_eq "--no-codex-auth skips the Codex login" 0 "$(count_in_log CODEX_AUTH)"
assert_eq "no Fireworks key file means no Fireworks secret" 0 "$(count_in_log FIREWORKS_API_KEY)"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "  $FAKE_FIREWORKS  " > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "new installs the saved Fireworks key" 0 "$RC"
fireworks_call=$(grep -n 'FIREWORKS_API_KEY' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the Fireworks key reaches only setup-secrets stdin, trimmed" "$FAKE_FIREWORKS" "$(stdin_of "$fireworks_call")"
assert_no_secret_leak "new with a Fireworks key"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_FIREWORKS other" > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "a Fireworks key file with two words fails" 1 "$RC"
assert_contains "a Fireworks key file with two words says so" "more than one word" "$OUT"
assert_eq "a Fireworks key file with two words creates no VM" 0 "$(count_in_log clone)"
assert_no_secret_leak "a Fireworks key file with two words"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
: > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "an empty Fireworks key file fails" 1 "$RC"
assert_eq "an empty Fireworks key file creates no VM" 0 "$(count_in_log clone)"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
ln -s "$HOME_DIR/.config/secrets/missing" "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "a dangling Fireworks key link fails" 1 "$RC"
assert_contains "a dangling Fireworks key link says it is not a regular file" "is not a regular file" "$OUT"
assert_eq "a dangling Fireworks key link creates no VM" 0 "$(count_in_log clone)"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_FIREWORKS other" > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-codex-auth
assert_eq "a bad Fireworks key file fails with the Claude token still to ask for" 1 "$RC"
assert_contains "a bad Fireworks key file is reported" "more than one word" "$OUT"
assert_eq "a bad Fireworks key file is reported before the Claude token is asked for" 0 \
    "$([[ $OUT == *'keeps the token for next time'* ]] && echo 1 || echo 0)"
assert_no_secret_leak "a bad Fireworks key file before the Claude prompt"

new_gateway_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_CLAUDE" > "$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
run_cog new t1 --no-repo --no-codex-auth
assert_eq "new reuses the saved Claude token" 0 "$RC"
claude_call=$(grep -n 'CLAUDE_CODE_OAUTH_TOKEN' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the saved Claude token reaches setup-secrets" "$FAKE_CLAUDE" "$(stdin_of "$claude_call")"

new_gateway_case test-base
print -r -- '[]' > "$HOME_DIR/.codex/auth.json"
run_cog new t1 --no-repo
assert_eq "invalid Codex login fails before cloning" 1 "$RC"
assert_eq "invalid Codex login creates no VM" 0 "$(count_in_log clone)"

new_gateway_case test-base
EXTRA_ENV+=(COG_GITHUB_WEB_URL=https://github.com)
unseed_auth shields/dotfiles
: > "$STATE/gh-fail"
run_cog new t1 --no-claude-token --no-codex-auth
assert_eq "new infers the GitHub origin" 0 "$RC"
assert_contains "new says where the repository comes from" "using shields/dotfiles from the origin of this checkout" "$OUT"
assert_eq "the inferred public repository needs no grant" '{}' "$(instance_query t1 .grants)"
assert_eq "new skips gh for the inferred public repository" no "$([[ -e $STATE/gh.log ]] && echo yes || echo no)"

new_gateway_case test-base
EXTRA_ENV+=(COG_GITHUB_WEB_URL=https://github.com)
: > "$STATE/gh-fail"
run_cog new t1 --repo shields/cog
assert_eq "new can clone cog without authorization" 0 "$RC"
assert_eq "cog gets no repository grant" '{}' "$(instance_query t1 .grants)"
assert_contains "new clones cog anonymously" "git clone --quiet https://github.com/shields/cog.git" "$(<"$STATE/limactl.log")"

new_gateway_case test-base
run_cog new t1 --repo shields/unavailable
assert_eq "an upstream error stops new" 1 "$RC"
assert_contains "new reports the anonymous lookup error" "HTTP 503" "$OUT"
assert_eq "an upstream error does not start authorization" no "$([[ -e $STATE/gh.log ]] && echo yes || echo no)"
assert_eq "an upstream error creates no VM" 0 "$(count_in_log clone)"

new_case test-base
run_cog new t1 --repo shields/dotfiles
assert_eq "an unavailable gateway stops new" 1 "$RC"
assert_contains "an unavailable gateway points to cog's installer" "./install.sh" "$OUT"
assert_eq "an unavailable gateway creates no VM" 0 "$(count_in_log clone)"

new_gateway_case test-base
register_vm t1
EXTRA_ENV+=(LIMA_STUB_SNAPSHOT=delete)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed registration stops new" 1 "$RC"
assert_contains "a failed registration says so" "cannot register t1 with the GitHub gateway" "$OUT"
assert_contains "a failed registration deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
assert_eq "a failed registration leaves no instance" 0 "$(grep -cx t1 "$STATE/instances" || true)"
assert_eq "a failed registration leaves the earlier registration alone" '{"disabled":false,"revision":0}' \
    "$(instance_query t1 '{disabled, revision}')"
assert_eq "a failed registration installs nothing in the guest" 0 "$(count_in_log setup-)"

new_gateway_case test-base
EXTRA_ENV+=(LIMA_STUB_FAIL=setup-github-gateway LIMA_STUB_SNAPSHOT=delete)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed guest setup stops new" 1 "$RC"
assert_eq "a failed guest setup disables gateway access and removes the grants" '{"disabled":true,"grants":{}}' \
    "$(instance_query t1 '{disabled, grants}')"
assert_contains "a failed guest setup deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
delete_call=$(grep -n '^delete ' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "a failed guest setup disables access before it deletes the VM" true \
    "$(jq -r '.instances[0].disabled' "$STATE/snapshots/$delete_call.json")"
assert_eq "a failed guest setup installs no secret" 0 "$(count_in_log setup-secrets)"

new_gateway_case test-base
EXTRA_ENV+=(LIMA_STUB_FAIL=__cog__/health)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed relay probe stops new" 1 "$RC"
assert_eq "a failed relay probe disables gateway access" true "$(instance_query t1 .disabled)"
assert_eq "a failed relay probe installs no secret" 0 "$(count_in_log setup-secrets)"

new_gateway_case test-base
EXTRA_ENV+=(LIMA_STUB_FAIL="brew upgrade")
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed agent upgrade stops new" 1 "$RC"
assert_eq "a failed agent upgrade disables gateway access" true "$(instance_query t1 .disabled)"
assert_eq "a failed agent upgrade installs no secret" 0 "$(count_in_log setup-secrets)"
assert_eq "a failed agent upgrade installs no gateway setup" 0 "$(count_in_log setup-github-gateway)"

new_gateway_case test-base
run_cog new t1 --repo shields/dotfiles
upgrade_call=$(grep -n 'brew upgrade --cask claude-code@latest codex' "$STATE/limactl.log" | head -1 | cut -d: -f1)
first_secret_call=$(grep -n 'setup-secrets' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the agents are upgraded before any secret is installed" 1 "$(( upgrade_call < first_secret_call ))"

# --- 9. github and rm ---
new_case test-base t1
prepare_gateway
register_vm t1
run_cog grant t1 shields/other
assert_eq "github adds an additional repository" 0 "$RC"
assert_eq "github grants the cog profile" '{"shields/other":{"read":true,"pushCogBranches":true}}' "$(instance_query t1 .grants)"
assert_eq "github does not copy a credential into the guest" 0 "$(count_in_log setup-secrets)"
assert_eq "github does not start a stopped VM" 0 "$(count_in_log start)"

new_case test-base
prepare_gateway
run_cog grant missing shields/other
assert_eq "github refuses a missing VM" 1 "$RC"
assert_eq "github leaves policy unchanged for a missing VM" 0 "$(gateway_dump | jq '.instances | length')"

new_gateway_case test-base t1
register_vm t1
EXTRA_ENV+=(LIMA_STUB_SNAPSHOT=delete)
run_cog rm test-base
assert_eq "rm refuses the base" 1 "$RC"
assert_eq "rm of the base touches no VM" "" "$(limactl_log)"
run_cog rm t1
assert_eq "rm succeeds" 0 "$RC"
assert_eq "rm disables the grant" true "$(instance_query t1 .disabled)"
assert_contains "rm deletes the VM" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
delete_call=$(grep -n '^delete ' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "rm revokes before deleting" true "$(jq -r '.instances[0].disabled' "$STATE/snapshots/$delete_call.json")"

new_gateway_case test-base t1
run_cog rm t1
assert_eq "rm of a VM the gateway does not know fails" 1 "$RC"
assert_contains "rm of an unknown VM says why" "VM is not active" "$OUT"
assert_eq "rm of an unknown VM deletes nothing" 0 "$(count_in_log delete)"

# --- 10. only the final shell reads cog's stdin ---
new_case test-base
stdin_marker
run_base none
assert_eq "base succeeds with stdin held" 0 "$RC"
assert_eq "base reads nothing from cog's stdin" "" "$(calls_reading_stdin)"

# --- 11. modes hold under any umask ---
# tree_violations DIR: the entries of the tree whose mode is not what cog gives
# what it writes, 700 for a directory or a socket and 600 for a file.
tree_violations() {
    local root=$1 entry want
    local -a mode
    for entry in "$root" "$root"/**/*(DN); do
        zstat -L -A mode +mode -- "$entry"
        if [[ -d $entry || -S $entry ]]; then
            want=700
        else
            want=600
        fi
        [[ $(printf '%o' $(( mode[1] & 8#7777 ))) == $want ]] || print -r -- "${entry#$root} $(printf '%o' $(( mode[1] & 8#7777 )))"
    done
}

# archive_modes N: the mode and name of every entry in the archive that limactl
# call N read, in a form that GNU and BSD tar agree on.
archive_modes() {
    tar -tvf "$STATE/calls/$1.stdin" | awk '{print $1, $NF}' | sort
}

for umask_value in 022 000 077; do
    new_case
    RUN_UMASK=$umask_value
    run_cog claude-token
    assert_eq "claude-token succeeds under umask $umask_value" 0 "$RC"
    assert_eq "claude-token keeps the token under umask $umask_value" "$FAKE_CLAUDE" "$(<"$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN")"
    assert_eq "claude-token under umask $umask_value makes everything it writes private" "" "$(tree_violations "$HOME_DIR/.config")"
    assert_eq "claude-token under umask $umask_value leaves only the token file" CLAUDE_CODE_OAUTH_TOKEN "$(ls -A "$HOME_DIR/.config/secrets")"
    assert_no_secret_leak "claude-token under umask $umask_value"

    new_case
    RUN_UMASK=$umask_value
    mkdir -p "$HOME_DIR/.config/secrets"
    chmod 755 "$HOME_DIR/.config/secrets"
    print -r -- old-token > "$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
    chmod 644 "$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
    run_cog claude-token
    assert_eq "claude-token replaces a token under umask $umask_value" "$FAKE_CLAUDE" "$(<"$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN")"
    assert_eq "claude-token tightens the modes of what was there under umask $umask_value" "" "$(tree_violations "$HOME_DIR/.config/secrets")"
    assert_eq "claude-token replacing a token leaves no temporary file under umask $umask_value" CLAUDE_CODE_OAUTH_TOKEN "$(ls -A "$HOME_DIR/.config/secrets")"

    new_case test-base
    RUN_UMASK=$umask_value
    start_gateway
    run_cog new t1 --repo shields/dotfiles
    assert_eq "new succeeds under umask $umask_value" 0 "$RC"
    assert_eq "the gateway's state under umask $umask_value is private" "" "$(tree_violations "$GATEWAY_ROOT/state")"
    assert_eq "the gateway's secrets under umask $umask_value are private" "" "$(tree_violations "$GATEWAY_ROOT/secrets")"
    assert_eq "the VM's socket directory under umask $umask_value is private" "" "$(tree_violations "$HOME_DIR/.lima/t1/sock")"
    assert_eq "the state directory holds the database and the admin socket under umask $umask_value" 1 \
        "$([[ -s $GATEWAY_ROOT/state/state.sqlite && -S $GATEWAY_ROOT/state/admin.sock ]] && echo 1 || echo 0)"

    new_case
    RUN_UMASK=$umask_value
    run_base none
    assert_eq "base succeeds under umask $umask_value" 0 "$RC"
    assert_eq "base's staging directory under umask $umask_value is private" 700 "$(<"$STAGE_ARGS_LOG.mode")"
    if [[ $umask_value == 022 ]]; then
        GUEST_MODES="$(archive_modes 7)"
        assert_eq "the staged tree keeps 0644 files, 0755 files and 0755 directories, apart from Git's own" "" \
            "$(archive_modes 5 | grep -vE ' \./\.git(/|$)' | grep -vE '^(-rw-r--r--|-rwxr-xr-x|drwxr-xr-x) ' || true)"
        assert_eq "the guest scripts keep 0644 files, 0755 files and 0755 directories" "" \
            "$(grep -vE '^(-rw-r--r--|-rwxr-xr-x|drwxr-xr-x) ' <<<"$GUEST_MODES" || true)"
    fi
    assert_eq "base sends the same modes for the guest scripts under umask $umask_value" "$GUEST_MODES" "$(archive_modes 7)"
done

# --- 12. a signal at each stage of new and base cleans up ---
# new_signal_stage SIGNAL STATUS STAGE BLOCK REGISTERED ARGS...: SIGNAL reaches
# new while the limactl call that contains BLOCK is held. REGISTERED is 1 when
# the VM is registered with the gateway by then.
new_signal_stage() {
    local signal=$1 expected=$2 stage=$3 block=$4 registered=$5 desc delete_call
    shift 5
    desc="$signal $stage"
    new_gateway_case test-base
    EXTRA_ENV+=(LIMA_STUB_BLOCK="$block" LIMA_STUB_SNAPSHOT=delete)
    run_cog_signal "$signal" new t1 "$@"
    assert_eq "$desc: new ends with the signal's status" "$expected" "$RC"
    assert_contains "$desc: new says it removes the VM" "removing t1 after the failure" "$OUT"
    assert_contains "$desc: new deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
    assert_eq "$desc: no instance is left" 0 "$(grep -cx t1 "$STATE/instances" || true)"
    if (( registered )); then
        assert_eq "$desc: gateway access is disabled and its grants removed" '{"disabled":true,"grants":{}}' \
            "$(instance_query t1 '{disabled, grants}')"
        delete_call=$(grep -n '^delete ' "$STATE/limactl.log" | head -1 | cut -d: -f1)
        assert_eq "$desc: access is disabled before the VM is deleted" true \
            "$(jq -r '.instances[0].disabled' "$STATE/snapshots/$delete_call.json")"
    else
        assert_eq "$desc: nothing was registered" null "$(instance_query t1 .id)"
    fi
    assert_eq "$desc: the daemon stays silent" "" "$(<"$STATE/gateway.err")"
    assert_no_secret_leak "$desc"
}

for entry in HUP:129 INT:130 TERM:143; do
    signal=${entry%%:*}
    expected=${entry#*:}
    new_signal_stage "$signal" "$expected" "after the clone" "{{.Dir}} t1" 0 --repo shields/dotfiles
    new_signal_stage "$signal" "$expected" "after the registration" "start --tty=false t1" 1 --repo shields/dotfiles
    new_signal_stage "$signal" "$expected" "during the Claude token install" "setup-secrets CLAUDE_CODE_OAUTH_TOKEN" 1 --repo shields/other
    new_signal_stage "$signal" "$expected" "during the Codex login install" "setup-secrets CODEX_AUTH" 1 --repo shields/other
done

new_gateway_case test-base
EXTRA_ENV+=(LIMA_STUB_BLOCK="start --tty=false t1" LIMA_STUB_SNAPSHOT=delete)
run_cog_signal --dead-output HUP new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "a hangup with no reader for the output ends new with the hangup status" 129 "$RC"
assert_eq "a hangup with no reader for the output disables gateway access" true "$(instance_query t1 .disabled)"
assert_contains "a hangup with no reader for the output deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
assert_eq "a hangup with no reader for the output leaves no instance behind" 0 "$(grep -cx t1 "$STATE/instances" || true)"

# base_signal_stage SIGNAL STATUS STAGE LEFT EXISTS VAR=VALUE: SIGNAL reaches
# base, which replaces an existing base, while stage_tree.sh (STAGE_STUB_BLOCK=1)
# or the limactl call that contains LIMA_STUB_BLOCK is held. LEFT is 1 when the
# new VM has been started by then, and EXISTS is 1 when a base VM exists after
# the signal.
base_signal_stage() {
    local signal=$1 expected=$2 stage=$3 left=$4 exists=$5 desc
    shift 5
    desc="$signal $stage"
    new_case test-base
    EXTRA_ENV+=("$@")
    RUN_CWD="$TMPBASE/elsewhere"
    run_cog_signal "$signal" base --dotfiles "$DOTFILES" none
    assert_eq "$desc: base ends with the signal's status" "$expected" "$RC"
    assert_eq "$desc: base removes its staging directory" 0 "$(staging_dirs_left)"
    assert_eq "$desc: a base VM exists exactly when the old one was kept or the new one was started" "$exists" \
        "$(grep -cx test-base "$STATE/instances" || true)"
    assert_eq "$desc: base deletes only the base it replaces, once the new one is going to start" "$left" \
        "$(grep -c '^delete ' "$STATE/limactl.log" || true)"
    if (( left )); then
        assert_contains "$desc: base says the VM is left for inspection" "left for inspection" "$OUT"
    else
        assert_eq "$desc: base touches no VM" "" "$(limactl_log)"
    fi
    assert_no_secret_leak "$desc"
}

for entry in HUP:129 INT:130 TERM:143; do
    signal=${entry%%:*}
    expected=${entry#*:}
    base_signal_stage "$signal" "$expected" "while staging" 0 1 STAGE_STUB_BLOCK=1
    base_signal_stage "$signal" "$expected" "while the VM starts" 1 0 LIMA_STUB_BLOCK="start --tty=false --name=test-base"
    base_signal_stage "$signal" "$expected" "while provisioning" 1 1 LIMA_STUB_BLOCK="./provision.sh"
done

# --- 13. a file that would be quoted by a parse error is not quoted ---
# The Codex login and the token files hold secrets, and the tool that parses
# them may print the text around a syntax error.
codex_contents=(
    "{\"tokens\": {\"access_token\": \"$FAKE_CODEX\""
    "$FAKE_CODEX"
    "[\"$FAKE_CODEX\"]"
    "{\"access_token\": \"$FAKE_CODEX\"} {\"again\": \"$FAKE_CODEX\"}"
    "{\"access_token\": \"$FAKE_CODEX\"} trailing"
    "{'access_token': '$FAKE_CODEX'}"
    "{\"access_token\": \"$FAKE_CODEX\",}"
)
for content in "${codex_contents[@]}"; do
    new_gateway_case test-base
    print -rn -- "$content" > "$HOME_DIR/.codex/auth.json"
    run_cog new t1 --no-repo --no-claude-token
    assert_eq "a Codex login that is not a JSON object fails new" 1 "$RC"
    assert_contains "a Codex login that is not a JSON object says so" "is not a JSON object" "$OUT"
    assert_eq "a Codex login that is not a JSON object creates no VM" 0 "$(count_in_log clone)"
    assert_eq "a Codex login that is not a JSON object registers no VM" 0 "$(gateway_dump | jq '.instances | length')"
    assert_no_secret_leak "a Codex login that is not a JSON object"
done

claude_contents=(
    "$FAKE_CLAUDE other"
    "$FAKE_CLAUDE"$'\n'"second-line"
    "$FAKE_CLAUDE"$'\t'"second"
    "other $FAKE_CLAUDE"
)
for content in "${claude_contents[@]}"; do
    new_gateway_case test-base
    mkdir -p "$HOME_DIR/.config/secrets"
    print -rn -- "$content" > "$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
    run_cog new t1 --no-repo --no-codex-auth
    assert_eq "a Claude token file with two words fails new" 1 "$RC"
    assert_contains "a Claude token file with two words says so" "holds more than one token" "$OUT"
    assert_eq "a Claude token file with two words creates no VM" 0 "$(count_in_log clone)"
    assert_no_secret_leak "a Claude token file with two words"
done

# The prompt reads one line.
multiline=$'*\n*'
for content in "${(@)claude_contents:#$~multiline}"; do
    new_gateway_case test-base
    print -rn -- "$content" > "$STATE/prompt"
    run_cog new t1 --no-repo --no-codex-auth
    assert_eq "a typed Claude token with two words fails new" 1 "$RC"
    assert_contains "a typed Claude token with two words says so" "has spaces in it" "$OUT"
    assert_eq "a typed Claude token with two words creates no VM" 0 "$(count_in_log clone)"
    assert_no_secret_leak "a typed Claude token with two words"

    new_case
    print -rn -- "$content" > "$STATE/prompt"
    run_cog claude-token
    assert_eq "claude-token with two words fails" 1 "$RC"
    assert_eq "claude-token with two words writes no file" no "$([[ -e $HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN ]] && echo yes || echo no)"
    assert_no_secret_leak "claude-token with two words"
done

assert_eq "no case called security" 0 "$(cat "$TMPBASE"/s[0-9]*/security.log(N) </dev/null | wc -l | tr -d ' ')"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
