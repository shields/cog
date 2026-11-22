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
COG="$HERE/../bin/cog"
FAKE_GITHUB="$HERE/fake_github.py"
REAL_CURL="$(command -v curl)"
REAL_GIT="$(command -v git)"
REAL_GITLEAKS="$(command -v gitleaks)"
TMPBASE="${$(mktemp -d):A}"
FAKE_PID=
stop_fake() {
    if [[ -n $FAKE_PID ]]; then
        kill -KILL "$FAKE_PID" 2>/dev/null || true
        wait "$FAKE_PID" 2>/dev/null || true
        FAKE_PID=
    fi
}
trap 'stop_fake; rm -rf "$TMPBASE"' EXIT
export TMPDIR="$TMPBASE/tmp"
mkdir -p "$TMPDIR"

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

# limactl keeps its instances and its calls under $LIMA_STUB_STATE, and a call
# whose arguments contain $LIMA_STUB_FAIL fails.
cat > "$STUBS/limactl" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
printf '%s\n' "$*" >> "$state/limactl.log"
printf 'limactl %s\n' "$*" >> "$state/all.log"
call=$(wc -l < "$state/limactl.log" | tr -d ' ')
printf '%s\n' "$@" > "$state/calls/$call.argv"
env | sort > "$state/calls/$call.env"
if [[ ! -t 0 ]]; then
    cat > "$state/calls/$call.stdin"
fi
if [[ -n ${LIMA_STUB_FAIL:-} && $* == *"$LIMA_STUB_FAIL"* ]]; then
    echo "limactl: injected failure" >&2
    exit 1
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

cat > "$STUBS/cog-gateway" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
printf '%s\n' "$*" >> "$state/cog-gateway.log"
printf 'cog-gateway %s\n' "$*" >> "$state/all.log"
if [[ -n ${COG_STUB_FAIL:-} && $* == *"$COG_STUB_FAIL"* ]]; then
    echo "cog-gateway: injected failure" >&2
    exit 1
fi
case $1 in
register)
    name=${2#lima:}
    [[ -d "$HOME/.lima/$name/sock" ]] || exit 1
    printf '{"id":"01234567-89ab-4cde-8fab-0123456789ab","socket":"%s"}\n' "$HOME/.lima/$name/sock/github-01234567-89ab-4cde-8fab-0123456789ab.sock"
    ;;
ca-path) echo "$state/gateway-ca.pem" ;;
esac
STUB

# gh answers the one read-only call cog makes, with the id in
# $LIMA_STUB_STATE/gh-id, and fails if $LIMA_STUB_STATE/gh-fail exists.
cat > "$STUBS/gh" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
call=$(mktemp "$state/calls/gh.XXXXXX")
printf '%s\n' "$@" > "$call.argv"
env | sort > "$call.env"
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
call=$(mktemp "$state/calls/curl.XXXXXX")
printf '%s\n' "$@" > "$call.argv"
env | sort > "$call.env"
exec "$REAL_CURL" "$@"
STUB

cat > "$STUBS/open" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$LIMA_STUB_STATE/open.log"
[[ ! -e $LIMA_STUB_STATE/open-fail ]]
STUB

# pbcopy records what it was given, and fails if $LIMA_STUB_STATE/pbcopy-fail
# exists.
cat > "$STUBS/pbcopy" <<'STUB'
#!/bin/bash
state=$LIMA_STUB_STATE
call=$(mktemp "$state/calls/pbcopy.XXXXXX")
printf '%s\n' "$@" > "$call.argv"
env | sort > "$call.env"
if [[ -e $state/pbcopy-fail ]]; then
    echo "pbcopy: injected failure" >&2
    exit 1
fi
cat > "$state/pbcopy.stdin"
STUB

cat > "$STUBS/sleep" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$LIMA_STUB_STATE/sleep.log"
STUB

# cog has no use for the macOS security command, so any call is a failure.
cat > "$STUBS/security" <<'STUB'
#!/bin/bash
echo "called: $*" >> "$LIMA_STUB_STATE/security.log"
echo "security: cog must not call this" >&2
exit 1
STUB
cat > "$STUBS/gitleaks" <<'STUB'
#!/bin/bash
[[ -z ${LIMA_STUB_STATE:-} ]] || printf '%s\n' "$*" >> "$LIMA_STUB_STATE/gitleaks.log"
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
call=$(mktemp "$LIMA_STUB_STATE/calls/git.XXXXXX")
printf '%s\n' "$@" > "$call.argv"
env | sort > "$call.env"
exec "$REAL_GIT" "$@"
STUB
chmod +x "$STUBS"/*

cat > "$TMPBASE/stage_tree.sh" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" > "$STAGE_ARGS_LOG"
if [[ -n ${STAGE_STUB_FAIL:-} ]]; then
    echo "stage_tree: injected failure" >&2
    exit 1
fi
exec "$(dirname "$0")/stage_tree_real.sh" "$@"
STUB

# The cog checkout: cog's own resources, with the real guest scripts and the
# real staging script behind a stub that records its arguments.
COGTREE="$TMPBASE/cog"
mkdir -p "$COGTREE/bin" "$COGTREE/lima" "$COGTREE/tools"
cp "$COG" "$COGTREE/bin/cog"
cp -R "$HERE/../guest" "$COGTREE/guest"
rm -rf "$COGTREE/guest/__pycache__"
: > "$COGTREE/lima/dev.yaml"
cp "$TMPBASE/stage_tree.sh" "$COGTREE/tools/stage_tree.sh"
cp "$HERE/../tools/stage_tree.sh" "$COGTREE/tools/stage_tree_real.sh"
chmod +x "$COGTREE/tools/stage_tree.sh"
COGBIN="$COGTREE/bin/cog"
GUEST_FILES="$(cd "$COGTREE/guest" && find . -type f | sort)"

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
CLIENT_ID=Iv23lim5x4MdkNNgv28z
FAKE_CLAUDE='sk-ant-oat01-FAKEclaudeToken-7f3c9a'
FAKE_CODEX='FAKE-codex-access-token-4c8e'
FAKE_FIREWORKS='fw_FAKEfireworksKey0123'
CODEX_JSON=$'{\n  "OPENAI_API_KEY": null,\n  "tokens": {\n    "access_token": "'"$FAKE_CODEX"$'",\n    "refresh_token": "FAKE-codex-refresh-9d1a"\n  }\n}\n'
# What the fake GitHub hands out, and the device code it expects back.
GITHUB_SECRETS=(-e ghu_fake-access -e ghr_fake-refresh -e fake-device-code)
GUEST_LIB=/usr/local/lib/cog

CASE_N=0
EXTRA_ENV=()
FAKE_URL=

# new_case [INSTANCE...]: a fresh state with a home that holds a Codex login, a
# Claude token to type and the instances that exist.
new_case() {
    stop_fake
    (( ++CASE_N ))
    STATE="$TMPBASE/state-$CASE_N"
    HOME_DIR="$TMPBASE/home-$CASE_N"
    mkdir -p "$STATE/calls" "$HOME_DIR/.codex"
    print -rn -- "$CODEX_JSON" > "$HOME_DIR/.codex/auth.json"
    : > "$STATE/instances"
    (( $# == 0 )) || printf '%s\n' "$@" >> "$STATE/instances"
    : > "$STATE/limactl.log"
    : > "$STATE/cog-gateway.log"
    echo 4242 > "$STATE/gh-id"
    print -r -- "$FAKE_CLAUDE" > "$STATE/prompt"
    print -r -- "TEST-GATEWAY-CA" > "$STATE/gateway-ca.pem"
    STAGE_ARGS_LOG="$STATE/stage-args"
    FAKE_URL=
    RUN_PATH=
    RUN_STDIN=
    RUN_COG=
    RUN_CWD=
    EXTRA_ENV=(COG_PROMPT_INPUT="$STATE/prompt")
}

# start_fake [JSON FIELDS]: a fake GitHub on a free port for the current case,
# with the repositories shields/dotfiles (4242) and shields/other (77), and
# cog aimed at it. FAKE_CLIENT_ID is the client id it accepts.
start_fake() {
    local fields=${1:+, $1}
    print -r -- "{\"port_file\": \"$STATE/fake.port\", \"log\": \"$STATE/fake.log\", \"client_id\": \"${FAKE_CLIENT_ID:-$CLIENT_ID}\", \"repo_ids\": {\"shields/dotfiles\": 4242, \"shields/other\": 77}$fields}" > "$STATE/fake.json"
    python3 "$FAKE_GITHUB" "$STATE/fake.json" &
    FAKE_PID=$!
    local tries
    for tries in {1..200}; do
        [[ -s "$STATE/fake.port" ]] && break
        sleep 0.05
    done
    if [[ ! -s "$STATE/fake.port" ]]; then
        echo "the fake GitHub did not start" >&2
        exit 1
    fi
    FAKE_URL="http://127.0.0.1:$(<"$STATE/fake.port")"
    EXTRA_ENV+=(COG_GITHUB_WEB_URL="$FAKE_URL" COG_GITHUB_API_URL="$FAKE_URL/api/v3")
}

# no_pbcopy_path: the test PATH with every pbcopy removed, each directory that
# holds one replaced by a directory of links to its other commands.
no_pbcopy_path() {
    local dir farm cmd result= stubbed_path="$STUBS:$PATH"
    for dir in ${(s<:>)stubbed_path}; do
        if [[ -e $dir/pbcopy ]]; then
            farm="$TMPBASE/no-pbcopy$dir"
            if [[ ! -d $farm ]]; then
                mkdir -p "$farm"
                for cmd in "$dir"/*(N); do
                    [[ ${cmd:t} == pbcopy ]] || ln -s "$cmd" "$farm/${cmd:t}"
                done
            fi
            dir=$farm
        fi
        result+="${result:+:}$dir"
    done
    print -r -- "$result"
}

# Every run gets a GitHub that nothing listens on, so that the checkout's origin
# never leads a case to the real one; start_fake replaces it, later in the
# environment.
UNREACHABLE_GITHUB=http://127.0.0.1:9

# run_cog ARGS...: sets OUT (stdout and stderr) and RC. RUN_PATH replaces
# the stubbed PATH for one case, RUN_STDIN names a file to give cog on stdin
# instead of nothing, RUN_COG replaces the script that runs, and RUN_CWD is the
# current directory, the dotfiles checkout unless a case says otherwise (new
# reads its repository from there).
run_cog() {
    RC=0
    OUT="$(cd "${RUN_CWD:-$DOTFILES}" && env PATH="${RUN_PATH:-$STUBS:$PATH}" HOME="$HOME_DIR" USER=shields \
        LIMA_STUB_STATE="$STATE" STAGE_ARGS_LOG="$STAGE_ARGS_LOG" COG_BASE=test-base \
        REAL_CURL="$REAL_CURL" REAL_GIT="$REAL_GIT" REAL_GITLEAKS="$REAL_GITLEAKS" \
        NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 COG_GITHUB_WEB_URL="$UNREACHABLE_GITHUB" \
        "${EXTRA_ENV[@]}" /bin/bash "${RUN_COG:-$COGBIN}" "$@" 2>&1 <"${RUN_STDIN:-/dev/null}")" || RC=$?
}

# run_base ARGS...: cog base from a directory that is not a checkout, with the
# dotfiles checkout named, so that nothing is inferred from where it runs.
run_base() {
    local cwd=$RUN_CWD
    RUN_CWD="$TMPBASE/elsewhere"
    run_cog base --dotfiles "$DOTFILES" "$@"
    RUN_CWD=$cwd
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
    sed "s|$COGTREE|COG|g; s|$DOTFILES|DOTFILES|g; s|$TMPBASE|TMP|g" "$STATE/limactl.log"
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

fake_requests() {
    [[ -e "$STATE/fake.log" ]] || return 0
    jq -r '"\(.method) \(.path)"' "$STATE/fake.log"
}

fake_form() {
    [[ -e "$STATE/fake.log" ]] || return 0
    jq -r --arg path "$1" --arg field "$2" 'select(.path == $path) | .form[$field] // empty' "$STATE/fake.log"
}

stub_calls() {
    local name=$1
    ls "$STATE/calls" | grep -c "^$name\\..*\\.argv\$" || true
}

# None of the secrets may show in what a stub was given as arguments or
# environment, in the logs of the stubs, or in what cog printed. They go over
# stdin and nowhere else.
assert_no_secret_leak() {
    local desc="$1" leaks
    leaks="$(cat "$STATE"/calls/*.argv(N) "$STATE"/calls/*.env(N) "$STATE/limactl.log" "$STATE/cog-gateway.log" \
        "$STATE"/gh.log "$STATE"/open.log "$STATE"/sleep.log 2>/dev/null |
        grep -c -e "$FAKE_CLAUDE" -e "$FAKE_CODEX" -e "$FAKE_FIREWORKS" "${GITHUB_SECRETS[@]}" || true)"
    assert_eq "$desc: no secret in any recorded argv, environment or log" 0 "$leaks"
    assert_eq "$desc: no secret in cog's output" 0 \
        "$(printf '%s' "$OUT" | grep -c -e "$FAKE_CLAUDE" -e "$FAKE_CODEX" -e "$FAKE_FIREWORKS" "${GITHUB_SECRETS[@]}" || true)"
}

# --- 1. Static checks ---
assert_eq "no bash 4 constructs" "" \
    "$(grep -vE '^[[:space:]]*#' "$COG" | grep -nE 'mapfile|readarray|declare +-A|local +-n|\$\{[A-Za-z_0-9]+(,,|\^\^|@[LUu])' || true)"
assert_eq "cog is run by the system bash" "#!/bin/bash" "$(head -1 "$COG")"
assert_eq "no eval" 0 "$(grep -cE '(^|[^a-z_])eval ' "$COG" || true)"
assert_eq "cog is executable" yes "$([[ -x $COG ]] && echo yes || echo no)"
assert_eq "cog does not use the Keychain" 0 "$(grep -ciE 'keychain|need security|find-generic-password' "$COG" || true)"

# --- 2. help and bad invocations ---
new_case
run_cog help
assert_eq "help succeeds" 0 "$RC"
assert_contains "help lists base" "cog base" "$OUT"
assert_contains "help lists new" "cog new" "$OUT"
assert_contains "help lists github" "cog github NAME [OWNER/REPO]" "$OUT"
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
RC=0
OUT="$(cd "$DOTFILES" && env -u HOME PATH="$STUBS:$PATH" LIMA_STUB_STATE="$STATE" COG_BASE=test-base /bin/bash "$COG" help 2>&1)" || RC=$?
assert_eq "help without HOME fails" 1 "$RC"
assert_contains "help without HOME says so" "cog: HOME is not set" "$OUT"
run_cog frobnicate
assert_eq "unknown command fails" 2 "$RC"
run_cog new a b
assert_eq "new with two names fails" 1 "$RC"
run_cog list
assert_eq "list succeeds" 0 "$RC"
assert_eq "list is limactl list" "list" "$(limactl_log)"

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
shell test-base sudo chmod -R go-w $GUEST_LIB
shell --workdir $GUEST_DIR test-base ./provision.sh none
shell --workdir $GUEST_DIR test-base git reset --mixed --quiet HEAD
shell test-base sudo $GUEST_LIB/throwaway.sh --claude-settings $GUEST_DIR/.claude/settings.json --no-github-timer
shell --workdir $GUEST_DIR test-base env PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin uv run --no-dev python tools/configure_codex.py /home/guest/.codex/config.toml
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
    "https://github.com/shields/dotfiles.git#$origin_marker"; do
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
RUN_CWD="$TMPBASE/hostile"
run_cog base --dotfiles "$DOTFILES" none
assert_eq "base run beside a decoy succeeds" 0 "$RC"
assert_contains "base starts the cog checkout's template, not the current directory's" \
    "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
assert_eq "base does not run the current directory's staging script" no "$([[ -e $TMPBASE/hostile-ran ]] && echo yes || echo no)"

# cog finds its resources from the checkout it lives in, however it is called.
new_case
mkdir -p "$TMPBASE/linkbin" "$TMPBASE/linkbin-relative"
ln -sfn "$COGBIN" "$TMPBASE/linkbin/cog"
ln -sfn ../cog/bin/cog "$TMPBASE/linkbin-relative/cog"
for RUN_COG in "$TMPBASE/linkbin/cog" "$TMPBASE/linkbin-relative/cog"; do
    : > "$STATE/limactl.log"
    run_base none
    assert_eq "base through a link to cog succeeds" 0 "$RC"
    assert_contains "base through a link uses the linked checkout's template" \
        "start --tty=false --name=test-base COG/lima/dev.yaml" "$(limactl_log)"
done
RUN_COG=

new_case
cp -R "$COGTREE" "$TMPBASE/cog-incomplete"
rm -rf "$TMPBASE/cog-incomplete/guest"
RUN_COG="$TMPBASE/cog-incomplete/bin/cog"
run_base none
assert_eq "a cog checkout without guest scripts fails base" 1 "$RC"
assert_contains "it says the checkout is incomplete" "is not a cog checkout" "$OUT"
assert_eq "it touches no VM" "" "$(limactl_log)"
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
assert_eq "group and other write is removed after ownership" "shell"$'\n'"test-base"$'\n'"sudo"$'\n'"chmod"$'\n'"-R"$'\n'"go-w"$'\n'"$GUEST_LIB" \
    "$(<"$STATE/calls/9.argv")"
assert_eq "the guest scripts keep their executable bits in the archive" "yes" \
    "$(tar -tvf "$STATE/calls/7.stdin" | grep -q '^-rwx.* ./throwaway.sh$' && echo yes || echo no)"
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
printf 'COG_GUEST_SENTINEL\n' > "$COGTREE/guest/planted"
cat > "$STATE/gitleaks.toml" <<'EOF'
[[rules]]
id = "guest-marker"
description = "guest script regression marker"
regex = '''COG_GUEST_SENTINEL'''
EOF
EXTRA_ENV+=(GITLEAKS_CONFIG="$STATE/gitleaks.toml")
run_base none
rm "$COGTREE/guest/planted"
assert_eq "a planted secret in guest/ fails base" 1 "$RC"
assert_contains "a planted secret in guest/ names the file" planted "$OUT"
assert_eq "a planted secret in guest/ is redacted" no "$([[ $OUT == *COG_GUEST_SENTINEL* ]] && echo yes || echo no)"
assert_eq "a planted secret in guest/ touches no VM" "" "$(limactl_log)"
assert_eq "a planted secret in guest/ leaves no staging directory" 0 "$(staging_dirs_left)"

new_case test-base
ln -s /etc/passwd "$COGTREE/guest/link"
run_base none
rm "$COGTREE/guest/link"
assert_eq "a symlink in guest/ fails base" 1 "$RC"
assert_contains "a symlink in guest/ says why" "only regular files and directories" "$OUT"
assert_eq "a symlink in guest/ touches no VM" "" "$(limactl_log)"

assert_eq "nothing refers to the home directory's bin" "" \
    "$(grep -rnIE '\$HOME/bin|~/bin|/home/shields/bin|guest_home/bin' "$HERE/../guest" "$HERE/../cloudflare/guest" "$COG" || true)"
assert_eq "the image's credential helper is the root-owned one" 1 \
    "$(grep -c "'!/usr/local/lib/cog/github-gateway-credential'" "$HERE/../cloudflare/guest/agent.sh" || true)"
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

new_case test-base
run_cog new t1 --repo shields/dotfiles
assert_eq "new with a repository succeeds" 0 "$RC"
assert_contains "authorization happens before the clone" "cog-gateway ensure-auth shields/dotfiles" "$(<"$STATE/all.log")"
assert_contains "new registers the VM" "register lima:t1 --lima-dir $HOME_DIR/.lima/t1" "$(<"$STATE/cog-gateway.log")"
assert_contains "new installs reverse socket forwarding" 'guestSocket":"/tmp/cog-github.sock' "$(<"$STATE/limactl.log")"
assert_contains "new starts the VM after configuring its socket" "edit --tty=false --set" "$(<"$STATE/limactl.log")"
assert_contains "new installs guest trust and relay" "setup-github-gateway 01234567-89ab-4cde-8fab-0123456789ab" "$(<"$STATE/limactl.log")"
assert_contains "new runs the gateway setup from the root-owned directory" \
    "shell t1 sudo $GUEST_LIB/setup-github-gateway 01234567-89ab-4cde-8fab-0123456789ab" "$(<"$STATE/limactl.log")"
assert_contains "new installs the Claude token with the root-owned setup-secrets" \
    "shell t1 $GUEST_LIB/setup-secrets CLAUDE_CODE_OAUTH_TOKEN" "$(<"$STATE/limactl.log")"
assert_contains "new installs the Codex login with the root-owned setup-secrets" \
    "shell t1 $GUEST_LIB/setup-secrets CODEX_AUTH" "$(<"$STATE/limactl.log")"
assert_eq "new refers to nothing in the home directory's bin" 0 "$(grep -cE '/bin/setup-|HOME/bin|/home/guest/bin' "$STATE/limactl.log" || true)"
assert_contains "new probes the guest relay" "/__cog__/health" "$(<"$STATE/limactl.log")"
assert_contains "new grants cog access" "grant lima:t1 shields/dotfiles --profile cog" "$(<"$STATE/cog-gateway.log")"
assert_contains "new verifies the granted repository" "https://api.github.com/repos/shields/dotfiles" "$(<"$STATE/limactl.log")"
assert_eq "new sends no GitHub authorization to the guest" 0 "$(count_in_log GITHUB_APP_AUTH)"
assert_eq "new reuses the base checkout" 0 "$(count_in_log 'git clone')"
assert_contains "new opens the repository shell" "shell --workdir $GUEST_DIR t1" "$(<"$STATE/limactl.log")"
gateway_call=$(grep -n 'setup-github-gateway' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the guest receives only the gateway CA" TEST-GATEWAY-CA "$(stdin_of "$gateway_call")"
claude_call=$(grep -n 'CLAUDE_CODE_OAUTH_TOKEN' "$STATE/limactl.log" | head -1 | cut -d: -f1)
codex_call=$(grep -n 'CODEX_AUTH' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the Claude token reaches only setup-secrets stdin" "$FAKE_CLAUDE" "$(stdin_of "$claude_call")"
assert_eq "the Codex login reaches only setup-secrets stdin" "${CODEX_JSON%$'\n'}" "$(stdin_of "$codex_call")"
assert_no_secret_leak "new with a repository"

new_case test-base
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "new without a repository succeeds" 0 "$RC"
assert_eq "new without a repository makes no grant" 0 "$(grep -c '^grant ' "$STATE/cog-gateway.log" || true)"
assert_eq "new without a repository still installs the gateway" 1 "$(count_in_log setup-github-gateway)"
assert_eq "new without a repository sends no GitHub secret" 0 "$(count_in_log GITHUB_APP_AUTH)"
assert_eq "--no-claude-token skips the Claude secret" 0 "$(count_in_log CLAUDE_CODE_OAUTH_TOKEN)"
assert_eq "--no-codex-auth skips the Codex login" 0 "$(count_in_log CODEX_AUTH)"
assert_eq "no Fireworks key file means no Fireworks secret" 0 "$(count_in_log FIREWORKS_API_KEY)"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "  $FAKE_FIREWORKS  " > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "new installs the saved Fireworks key" 0 "$RC"
fireworks_call=$(grep -n 'FIREWORKS_API_KEY' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the Fireworks key reaches only setup-secrets stdin, trimmed" "$FAKE_FIREWORKS" "$(stdin_of "$fireworks_call")"
assert_no_secret_leak "new with a Fireworks key"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_FIREWORKS other" > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "a Fireworks key file with two words fails" 1 "$RC"
assert_contains "a Fireworks key file with two words says so" "more than one word" "$OUT"
assert_eq "a Fireworks key file with two words creates no VM" 0 "$(count_in_log clone)"
assert_no_secret_leak "a Fireworks key file with two words"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
: > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "an empty Fireworks key file fails" 1 "$RC"
assert_eq "an empty Fireworks key file creates no VM" 0 "$(count_in_log clone)"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
ln -s "$HOME_DIR/.config/secrets/missing" "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-claude-token --no-codex-auth
assert_eq "a dangling Fireworks key link fails" 1 "$RC"
assert_contains "a dangling Fireworks key link says it is not a regular file" "is not a regular file" "$OUT"
assert_eq "a dangling Fireworks key link creates no VM" 0 "$(count_in_log clone)"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_FIREWORKS other" > "$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
run_cog new t1 --no-repo --no-codex-auth
assert_eq "a bad Fireworks key file fails with the Claude token still to ask for" 1 "$RC"
assert_contains "a bad Fireworks key file is reported" "more than one word" "$OUT"
assert_eq "a bad Fireworks key file is reported before the Claude token is asked for" 0 \
    "$([[ $OUT == *'keeps the token for next time'* ]] && echo 1 || echo 0)"
assert_no_secret_leak "a bad Fireworks key file before the Claude prompt"

new_case test-base
mkdir -p "$HOME_DIR/.config/secrets"
print -r -- "$FAKE_CLAUDE" > "$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
run_cog new t1 --no-repo --no-codex-auth
assert_eq "new reuses the saved Claude token" 0 "$RC"
claude_call=$(grep -n 'CLAUDE_CODE_OAUTH_TOKEN' "$STATE/limactl.log" | head -1 | cut -d: -f1)
assert_eq "the saved Claude token reaches setup-secrets" "$FAKE_CLAUDE" "$(stdin_of "$claude_call")"

new_case test-base
print -r -- '[]' > "$HOME_DIR/.codex/auth.json"
run_cog new t1 --no-repo
assert_eq "invalid Codex login fails before cloning" 1 "$RC"
assert_eq "invalid Codex login creates no VM" 0 "$(count_in_log clone)"

new_case test-base
EXTRA_ENV+=(COG_GITHUB_WEB_URL=https://github.com)
run_cog new t1 --no-claude-token --no-codex-auth
assert_eq "new infers the GitHub origin" 0 "$RC"
assert_contains "the inferred repository is authorized" "ensure-auth shields/dotfiles" "$(<"$STATE/cog-gateway.log")"

new_case test-base
EXTRA_ENV+=(COG_STUB_FAIL=health)
run_cog new t1 --repo shields/dotfiles
assert_eq "an unavailable gateway stops new" 1 "$RC"
assert_contains "an unavailable gateway points to cog's installer" "./install.sh" "$OUT"
assert_eq "an unavailable gateway creates no VM" 0 "$(count_in_log clone)"

new_case test-base
EXTRA_ENV+=(COG_STUB_FAIL=register)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed registration stops new" 1 "$RC"
assert_contains "a failed registration deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"

new_case test-base
EXTRA_ENV+=(LIMA_STUB_FAIL=setup-github-gateway)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed guest setup stops new" 1 "$RC"
assert_contains "a failed guest setup disables gateway access" "disable lima:t1" "$(<"$STATE/cog-gateway.log")"
assert_contains "a failed guest setup deletes the clone" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"

new_case test-base
EXTRA_ENV+=(LIMA_STUB_FAIL=__cog__/health)
run_cog new t1 --repo shields/dotfiles
assert_eq "a failed relay probe stops new" 1 "$RC"
assert_contains "a failed relay probe disables gateway access" "disable lima:t1" "$(<"$STATE/cog-gateway.log")"

new_case test-base t1
run_cog github t1 shields/other
assert_eq "github adds an additional repository" 0 "$RC"
assert_contains "github uses the host policy" "grant lima:t1 shields/other --profile cog" "$(<"$STATE/cog-gateway.log")"
assert_eq "github does not copy a credential into the guest" 0 "$(count_in_log setup-secrets)"
assert_eq "github does not start a stopped VM" 0 "$(count_in_log start)"

new_case test-base
run_cog github missing shields/other
assert_eq "github refuses a missing VM" 1 "$RC"
assert_eq "github leaves policy unchanged for a missing VM" 0 "$(wc -l < "$STATE/cog-gateway.log" | tr -d ' ')"

new_case test-base t1
run_cog rm test-base
assert_eq "rm refuses the base" 1 "$RC"
run_cog rm t1
assert_eq "rm succeeds" 0 "$RC"
assert_contains "rm disables the grant" "disable lima:t1" "$(<"$STATE/cog-gateway.log")"
assert_contains "rm deletes the VM" "delete --tty=false --force t1" "$(<"$STATE/limactl.log")"
first_disable=$(grep -n '^cog-gateway disable lima:t1$' "$STATE/all.log" | head -1 | cut -d: -f1)
first_delete=$(grep -n '^limactl delete --tty=false --force t1$' "$STATE/all.log" | head -1 | cut -d: -f1)
assert_eq "rm revokes before deleting" 1 "$(( first_disable < first_delete ))"

assert_eq "no case called security" 0 "$(cat "$TMPBASE"/state-*/security.log(N) </dev/null | wc -l | tr -d ' ')"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
