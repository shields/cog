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

PYTHON="$(uv run --project "${0:A:h}/.." python -c 'import sys; print(sys.executable)')"
export PATH="${PYTHON:h}:$PATH"
SCRIPT="${0:A:h}/../guest/setup-secrets"
TMPBASE="$(mktemp -d)"
trap 'rm -rf "$TMPBASE"' EXIT

pass=0
fail=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "PASS: $desc"
        (( ++pass ))
    else
        echo "FAIL: $desc (expected=$expected actual=$actual)"
        (( ++fail ))
    fi
}

assert_absent() {
    local desc="$1" needle="$2" haystack="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        echo "PASS: $desc"
        (( ++pass ))
    else
        echo "FAIL: $desc ($needle appears)"
        (( ++fail ))
    fi
}

mode_of() {
    local -a mode
    zstat -A mode +mode "$1"
    printf '%o' $(( mode[1] & 8#7777 ))
}

SECRET='ghp_FAKEsecretValue0123456789abcdef'
new_home() {
    HOME_DIR="$TMPBASE/home-$1"
    mkdir -p "$HOME_DIR"
}

run() {
    local name="$1" input="$2"
    RC=0
    OUT="$(printf '%s' "$input" | env HOME="$HOME_DIR" bash "$SCRIPT" "$name" 2>&1)" || RC=$?
}

# --- 1. Arguments ---
new_home args
RC=0
OUT="$(printf '%s' "$SECRET" | env HOME="$HOME_DIR" bash "$SCRIPT" 2>&1)" || RC=$?
assert_eq "no argument fails" 1 "$RC"
assert_eq "no argument prints usage" 1 "$([[ "$OUT" == *usage:* ]] && echo 1 || echo 0)"
RC=0
OUT="$(printf '%s' "$SECRET" | env HOME="$HOME_DIR" bash "$SCRIPT" CODEX_AUTH extra 2>&1)" || RC=$?
assert_eq "extra argument fails" 1 "$RC"
RC=0
OUT="$(env HOME="$HOME_DIR" bash "$SCRIPT" --help 2>&1)" || RC=$?
assert_eq "--help succeeds" 0 "$RC"
assert_eq "--help names the secrets" 1 "$([[ "$OUT" == *CLAUDE_CODE_OAUTH_TOKEN* ]] && echo 1 || echo 0)"
assert_eq "--help names the Codex login" 1 "$([[ "$OUT" == *CODEX_AUTH* ]] && echo 1 || echo 0)"
assert_eq "--help names the Fireworks key" 1 "$([[ "$OUT" == *FIREWORKS_API_KEY* ]] && echo 1 || echo 0)"

# --- 2. Unknown names ---
new_home unknown
for name in BOGUS GH_TOKEN GITHUB_APP_AUTH '' 'GH_TOKEN;id' '../../x'; do
    run "$name" "$SECRET"
    assert_eq "unknown name '$name' fails" 1 "$RC"
    assert_eq "unknown name '$name' says so" 1 "$([[ "$OUT" == *"unknown secret"* ]] && echo 1 || echo 0)"
    assert_absent "unknown name '$name' does not echo the value" "$SECRET" "$OUT"
done
assert_eq "unknown names write nothing" "" "$(ls -A "$HOME_DIR")"

# --- 3. Empty input ---
new_home empty
for name in CLAUDE_CODE_OAUTH_TOKEN CODEX_AUTH FIREWORKS_API_KEY; do
    for input in '' $'\n' $'  \n\t\n'; do
        run "$name" "$input"
        assert_eq "$name with empty input fails" 1 "$RC"
        assert_eq "$name with empty input says so" 1 "$([[ "$OUT" == *empty* ]] && echo 1 || echo 0)"
    done
done
assert_eq "empty input writes nothing" "" "$(ls -A "$HOME_DIR")"

# --- 4. A terminal on stdin is refused, so a typed secret is never echoed ---
new_home tty
RC=0
OUT="$(python3 - "$SCRIPT" "$HOME_DIR" <<'PY' 2>&1
import os
import pty
import subprocess
import sys

script, home = sys.argv[1:]
master, slave = pty.openpty()
result = subprocess.run(
    ["bash", script, "CLAUDE_CODE_OAUTH_TOKEN"],
    stdin=slave,
    capture_output=True,
    text=True,
    env={**os.environ, "HOME": home},
    check=False,
)
print(result.returncode, result.stderr.strip())
PY
)" || RC=$?
assert_eq "terminal stdin: python ran" 0 "$RC"
assert_eq "terminal stdin is refused" 1 "$([[ "$OUT" == "1 setup-secrets: CLAUDE_CODE_OAUTH_TOKEN is read from stdin; pipe it in" ]] && echo 1 || echo 0)"
assert_eq "terminal stdin writes nothing" "" "$(ls -A "$HOME_DIR")"

# --- 5. CLAUDE_CODE_OAUTH_TOKEN ---
new_home claude
run CLAUDE_CODE_OAUTH_TOKEN "$SECRET"$'\n'
file="$HOME_DIR/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN"
assert_eq "claude token succeeds" 0 "$RC"
assert_eq "claude token prints nothing" "" "$OUT"
assert_eq "claude token content" "$SECRET" "$(<"$file")"
assert_eq "claude token has one trailing newline" "$(( ${#SECRET} + 1 ))" "$(wc -c < "$file" | tr -d ' ')"
assert_eq "claude token file mode" 600 "$(mode_of "$file")"
assert_eq "claude token directory mode" 700 "$(mode_of "$HOME_DIR/.config/secrets")"
assert_eq "claude token leaves no temporary file" 1 "$(ls -A "$HOME_DIR/.config/secrets" | wc -l | tr -d ' ')"

chmod 755 "$HOME_DIR/.config/secrets"
chmod 644 "$file"
run CLAUDE_CODE_OAUTH_TOKEN "second-value"
assert_eq "claude token replacement succeeds" 0 "$RC"
assert_eq "claude token replacement content" "second-value" "$(<"$file")"
assert_eq "claude token replacement file mode" 600 "$(mode_of "$file")"
assert_eq "claude token replacement directory mode" 700 "$(mode_of "$HOME_DIR/.config/secrets")"

# --- 5a. CODEX_AUTH ---
CODEX_ACCESS='FAKE-codex-access-token-4c8e'
CODEX_JSON=$'{\n  "OPENAI_API_KEY": null,\n  "tokens": {\n    "access_token": "'"$CODEX_ACCESS"$'",\n    "refresh_token": "FAKE-codex-refresh-9d1a"\n  },\n  "last_refresh": "2026-10-08T00:00:00Z"\n}'
new_home codex
run CODEX_AUTH "$CODEX_JSON"$'\n'
file="$HOME_DIR/.codex/auth.json"
assert_eq "codex auth succeeds" 0 "$RC"
assert_eq "codex auth prints nothing" "" "$OUT"
assert_eq "codex auth keeps the JSON intact, line by line" same \
    "$(printf '%s\n' "$CODEX_JSON" | cmp -s - "$file" && echo same || echo different)"
assert_eq "codex auth file mode" 600 "$(mode_of "$file")"
assert_eq "codex auth directory mode" 700 "$(mode_of "$HOME_DIR/.codex")"
assert_eq "codex auth leaves no temporary file" auth.json "$(ls -A "$HOME_DIR/.codex")"

new_home codexreplace
mkdir -p "$HOME_DIR/.codex"
printf '{"old": true}\n' > "$HOME_DIR/.codex/auth.json"
printf 'model = "x"\n' > "$HOME_DIR/.codex/config.toml"
chmod 755 "$HOME_DIR/.codex"
run CODEX_AUTH '{"new": true}'
assert_eq "codex auth replacement succeeds" 0 "$RC"
assert_eq "codex auth replacement content" '{"new": true}' "$(<"$HOME_DIR/.codex/auth.json")"
assert_eq "codex auth replacement directory mode" 700 "$(mode_of "$HOME_DIR/.codex")"
assert_eq "codex auth leaves the other Codex files alone" 'model = "x"' "$(<"$HOME_DIR/.codex/config.toml")"

new_home codexbad
for input in "\"$CODEX_ACCESS\"" '[]' "[\"$CODEX_ACCESS\"]" 'null' '42' 'not json' "{\"tokens\": \"$CODEX_ACCESS\"" '{} {}'; do
    run CODEX_AUTH "$input"
    assert_eq "a Codex value that is not an object fails: $input" 1 "$RC"
    assert_eq "a Codex value that is not an object says so: $input" 1 "$([[ "$OUT" == *"not a JSON object"* ]] && echo 1 || echo 0)"
    assert_absent "a Codex value that is not an object is not echoed: $input" "$CODEX_ACCESS" "$OUT"
    assert_eq "a Codex value that is not an object writes nothing: $input" "" "$(ls -A "$HOME_DIR")"
done

# --- 6a. FIREWORKS_API_KEY ---
FIREWORKS_KEY='fw_FAKEfireworksKey0123'
new_home fireworks
run FIREWORKS_API_KEY "$FIREWORKS_KEY"$'\n'
file="$HOME_DIR/.config/secrets/FIREWORKS_API_KEY"
assert_eq "fireworks key succeeds" 0 "$RC"
assert_eq "fireworks key prints nothing" "" "$OUT"
assert_eq "fireworks key content" "$FIREWORKS_KEY" "$(<"$file")"
assert_eq "fireworks key file mode" 600 "$(mode_of "$file")"
assert_eq "fireworks key directory mode" 700 "$(mode_of "$HOME_DIR/.config/secrets")"
assert_eq "fireworks key leaves no temporary file" FIREWORKS_API_KEY "$(ls -A "$HOME_DIR/.config/secrets")"

chmod 755 "$HOME_DIR/.config/secrets"
chmod 644 "$file"
run FIREWORKS_API_KEY "fw_second"
assert_eq "fireworks key replacement succeeds" 0 "$RC"
assert_eq "fireworks key replacement content" "fw_second" "$(<"$file")"
assert_eq "fireworks key replacement file mode" 600 "$(mode_of "$file")"
assert_eq "fireworks key replacement directory mode" 700 "$(mode_of "$HOME_DIR/.config/secrets")"

RC=0
OUT="$(printf '%s' "$SECRET" | env -u HOME bash "$SCRIPT" CLAUDE_CODE_OAUTH_TOKEN 2>&1)" || RC=$?
assert_eq "no HOME fails" 1 "$RC"
assert_eq "no HOME says so" 1 "$([[ "$OUT" == *"HOME is not set"* ]] && echo 1 || echo 0)"

assert_eq "no secret is stored where it should not be" 0 \
    "$(grep -rl --exclude=CLAUDE_CODE_OAUTH_TOKEN "$SECRET" "$TMPBASE"/home-* 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "only the Codex record holds the Codex token" "$TMPBASE/home-codex/.codex/auth.json" \
    "$(grep -rl "$CODEX_ACCESS" "$TMPBASE"/home-* 2>/dev/null)"
assert_eq "the replaced Fireworks key is left nowhere" 0 \
    "$(grep -rl "$FIREWORKS_KEY" "$TMPBASE"/home-* 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
