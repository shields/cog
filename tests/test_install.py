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

import itertools
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest

REPO = Path(__file__).resolve().parents[1]
LABEL = "dev.msrl.cog.gateway"
DOMAIN = f"gui/{os.getuid()}"
SERVICE = f"{DOMAIN}/{LABEL}"

STUB = r"""#!/bin/bash
set -euo pipefail
signal_at() {
    local when=${TEST_SIGNAL_AT:-} count=0
    [[ $when == "$1:"* ]] || return 0
    [[ ! -e $TEST_STATE/count-$1 ]] || count=$(<"$TEST_STATE/count-$1")
    printf '%s\n' "$((count + 1))" > "$TEST_STATE/count-$1"
    [[ $((count + 1)) == "${when#*:}" ]] || return 0
    kill -s "${TEST_SIGNAL:-INT}" "$PPID"
}
case ${0##*/} in
    uname) printf '%s\n' "${TEST_OS:-Darwin}" ;;
    sleep)
        printf 'sleep %s\n' "$*" >> "$TEST_STATE/calls"
        signal_at sleep
        ;;
    plutil)
        [[ $# == 2 && $1 == -lint ]] || exit 1
        printf 'lint\n' >> "$TEST_STATE/calls"
        [[ ! -f "$TEST_STATE/invalid-plist" ]] || exit 1
        python3 -I -c \
            'import plistlib, sys; plistlib.load(open(sys.argv[1], "rb"))' "$2"
        ;;
    bun)
        [[ $(pwd -P) == "$TEST_REPO" ]] || exit 1
        if [[ $1 == install ]]; then
            [[ $# == 2 && $2 == --frozen-lockfile ]] || exit 1
            printf 'install deps\n' >> "$TEST_STATE/calls"
        else
            [[ $# == 7 && $1 == build && $2 == --compile &&
                $3 == --no-compile-autoload-dotenv &&
                $4 == --no-compile-autoload-bunfig &&
                $5 == cog/main.ts && $6 == --outfile ]] || exit 1
            printf 'build\n' >> "$TEST_STATE/calls"
            build=new
            [[ ! -f $TEST_STATE/build ]] || build=$(<"$TEST_STATE/build")
            printf '#!/bin/bash\nexport TEST_BUILD=%s\n' "$build" > "$7"
            printf 'exec "$TEST_STATE/bin/health" "$@"\n' >> "$7"
            chmod +x "$7"
            signal_at build
        fi
        ;;
    sandbox-exec)
        [[ $(pwd -P) == / && $PATH == /usr/bin:/bin:/usr/sbin:/sbin &&
            -z ${COG_ROOT+x}${COG_BASE+x} ]] || exit 1
        printf 'sandbox-exec\n' >> "$TEST_STATE/calls"
        { printf '%s\n' "$@"; printf -- '--\n'; } >> "$TEST_STATE/sandbox-args"
        [[ $1 == -f && -f $2 && $# == 12 && $3 == -D && $4 == BINARY=/* ]] || exit 1
        binary=${4#BINARY=}
        cmp -s "$2" "$TEST_REPO/gateway/gateway.sb"
        shift 2
        for _ in 1 2 3 4; do
            [[ $1 == -D && $2 =~ ^[A-Z_]+=/ ]] || exit 1
            shift 2
        done
        [[ $# == 2 && $2 == help && $1 == "$binary" && -x $1 ]] || exit 1
        if [[ -f $TEST_STATE/sandbox-fails ]]; then
            printf 'sandbox-exec: stub failure\n' >&2
            exit 1
        fi
        ;;
    launchctl)
        printf '%s\n' "$*" >> "$TEST_STATE/calls"
        case $1 in
            print)
                [[ $# == 2 && $2 == "$TEST_SERVICE" ]] || exit 1
                if [[ -f $TEST_STATE/unloading ]]; then
                    remaining=$(<"$TEST_STATE/unloading")
                    if (( remaining == 0 )); then
                        rm "$TEST_STATE/unloading" "$TEST_STATE/loaded"
                    else
                        printf '%s\n' "$((remaining - 1))" > "$TEST_STATE/unloading"
                    fi
                fi
                [[ -f $TEST_STATE/loaded ]] || exit 1
                ;;
            bootout)
                [[ $# == 2 && $2 == "$TEST_SERVICE" &&
                    -f $TEST_STATE/loaded ]] || exit 1
                printf '%s\n' "${TEST_UNLOAD_DELAY:-0}" > "$TEST_STATE/unloading"
                signal_at bootout
                if [[ -f $TEST_STATE/bootout-fails-once ]]; then
                    rm "$TEST_STATE/bootout-fails-once"
                    exit 5
                fi
                ;;
            bootstrap)
                [[ $# == 3 && $2 == "$TEST_DOMAIN" && -f $3 &&
                    ! -e $TEST_STATE/loaded ]] || exit 1
                if [[ -f $TEST_STATE/bootstrap-fails-once ]]; then
                    rm "$TEST_STATE/bootstrap-fails-once"
                    exit 5
                fi
                signal_at bootstrap
                python3 -I -c '
import os, plistlib, sys
arguments = plistlib.load(open(sys.argv[1], "rb"))["ProgramArguments"]
sys.exit(not (
    arguments[:2] == ["/usr/bin/sandbox-exec", "-f"]
    and os.path.isfile(arguments[2])
    and open(arguments[2], "rb").read().startswith(open(sys.argv[2], "rb").read())
    and os.access(arguments[-3], os.X_OK)
))' "$3" "$TEST_REPO/gateway/gateway.sb" || exit 1
                : > "$TEST_STATE/loaded"
                ;;
            *) exit 2 ;;
        esac
        ;;
    health)
        [[ $# == 2 && $* == 'gateway health' &&
            -z ${COG_ROOT+x}${COG_BASE+x} ]] || exit 1
        printf 'health\n' >> "$TEST_STATE/calls"
        [[ -f $TEST_STATE/loaded && ! -f $TEST_STATE/unhealthy &&
            ! -f $TEST_STATE/unhealthy-${TEST_BUILD:-none} ]] || exit 1
        ;;
    *) exit 2 ;;
esac
"""


# A runner that was started in the background inherits ignored SIGINT, which
# bash cannot trap, and the interrupt tests send it.
def default_signals() -> None:
    _ = signal.signal(signal.SIGINT, signal.SIG_DFL)


@dataclass(frozen=True)
class Installation:
    root: Path
    home: Path

    @property
    def tools(self) -> Path:
        return self.root / "bin"

    @property
    def binary(self) -> Path:
        return self.home / ".local/share/cog/cog"

    @property
    def link(self) -> Path:
        return self.home / "bin/cog"

    @property
    def plist(self) -> Path:
        return self.home / f"Library/LaunchAgents/{LABEL}.plist"

    @property
    def profile(self) -> Path:
        return self.home / ".local/share/cog/gateway.sb"

    @property
    def real(self) -> Path:
        return self.home.resolve()

    @property
    def logs(self) -> Path:
        return self.home / "Library/Logs"

    @property
    def program_arguments(self) -> list[str]:
        with self.plist.open("rb") as stream:
            document = cast("dict[str, list[str]]", plistlib.load(stream))
        return document["ProgramArguments"]

    @property
    def parameters(self) -> dict[str, str]:
        arguments = self.program_arguments
        return {
            name: value
            for flag, pair in itertools.pairwise(arguments)
            if flag == "-D"
            for name, _, value in [pair.partition("=")]
        }

    @property
    def calls(self) -> list[str]:
        return (self.root / "calls").read_text().splitlines()

    def run(self, *args: str, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(REPO / "install.sh"), *args],
            cwd=self.root,
            env={
                "HOME": str(self.home),
                "PATH": str(self.tools),
                "CDPATH": str(self.root),
                "COG_ROOT": str(self.root / "not-the-agent-root"),
                "COG_BASE": "not a valid base name",
                "TEST_STATE": str(self.root),
                "TEST_REPO": str(REPO),
                "TEST_DOMAIN": DOMAIN,
                "TEST_SERVICE": SERVICE,
                **overrides,
            },
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
            preexec_fn=default_signals,
        )


@pytest.fixture
def installation(tmp_path: Path) -> Installation:
    result = Installation(tmp_path, tmp_path / "home & < > ' \" é")
    result.tools.mkdir()
    result.home.mkdir()
    (result.root / "calls").touch()
    for name in (
        "uname",
        "sleep",
        "plutil",
        "sandbox-exec",
        "bun",
        "launchctl",
        "health",
    ):
        command = result.tools / name
        _ = command.write_text(STUB)
        command.chmod(0o755)
    for name in (
        "cat",
        "chmod",
        "dirname",
        "ln",
        "mkdir",
        "mktemp",
        "mv",
        "readlink",
        "rm",
        "rmdir",
        "sed",
        "tar",
    ):
        tool = shutil.which(name)
        assert tool is not None
        (result.tools / name).symlink_to(tool)
    (result.tools / "python3").symlink_to(sys.executable)
    for name in ("limactl", "gitleaks", "git", "gh", "jq", "socat", "openssl"):
        (result.tools / name).symlink_to(result.tools / "health")
    return result


def installed(installation: Installation) -> list[Path]:
    return sorted(installation.binary.parent.iterdir())


def test_first_install(installation: Installation) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.calls == [
        "install deps",
        "build",
        "lint",
        "sandbox-exec",
        f"print {SERVICE}",
        f"bootstrap {DOMAIN} {installation.plist}",
        "health",
    ]
    assert installation.link.readlink() == installation.binary
    assert os.access(installation.binary, os.X_OK)
    assert installation.logs.is_dir()
    assert installed(installation) == [installation.binary, installation.profile]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]
    real = installation.real
    with installation.plist.open("rb") as stream:
        assert plistlib.load(stream) == {
            "Label": LABEL,
            "ProgramArguments": [
                "/usr/bin/sandbox-exec",
                "-f",
                str(real / ".local/share/cog/gateway.sb"),
                "-D",
                f"BINARY={real / '.local/share/cog/cog'}",
                "-D",
                f"STATE={real / '.local/state/cog'}",
                "-D",
                f"SECRETS={real / '.config/secrets/cog'}",
                "-D",
                f"FIREWORKS_KEY={real / '.config/secrets/FIREWORKS_API_KEY'}",
                str(real / ".local/share/cog/cog"),
                "gateway",
                "serve",
            ],
            "WorkingDirectory": "/",
            "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
            "RunAtLoad": True,
            "KeepAlive": True,
            "ExitTimeOut": 60,
            "StandardOutPath": str(installation.logs / f"{LABEL}.out"),
            "StandardErrorPath": str(installation.logs / f"{LABEL}.err"),
        }
    assert str(REPO) not in installation.plist.read_text()


def test_reinstall_replaces_the_binary_after_the_label_is_released(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    inode = installation.binary.stat().st_ino
    link_inode = installation.link.lstat().st_ino
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="2")
    assert second.returncode == 0, second.stderr
    assert installation.binary.stat().st_ino != inode
    assert installation.link.lstat().st_ino == link_inode
    assert installation.calls[offset:] == [
        "install deps",
        "build",
        "lint",
        "sandbox-exec",
        f"print {SERVICE}",
        f"bootout {SERVICE}",
        f"print {SERVICE}",
        "sleep 0.1",
        f"print {SERVICE}",
        "sleep 0.1",
        f"print {SERVICE}",
        f"bootstrap {DOMAIN} {installation.plist}",
        "health",
    ]


def test_reinstall_waits_for_a_gateway_that_finishes_its_requests(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="120")
    assert second.returncode == 0, second.stderr
    assert installation.calls[offset:].count("sleep 0.1") == 120
    assert installation.calls[-2:] == [
        f"bootstrap {DOMAIN} {installation.plist}",
        "health",
    ]


def test_reinstall_gives_up_on_a_gateway_that_outlives_exit_timeout(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    inode = installation.binary.stat().st_ino
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="800")
    assert second.returncode == 1
    assert "timed out waiting for" in second.stderr
    assert installation.calls[offset:].count("sleep 0.1") == 700
    assert installation.binary.stat().st_ino == inode
    assert not any(call.startswith("bootstrap") for call in installation.calls[offset:])
    assert not any(path.exists() for path in kept_copies(installation))


def test_health_timeout_names_the_error_log(installation: Installation) -> None:
    (installation.root / "unhealthy").touch()
    result = installation.run()
    assert result.returncode == 1
    assert str(installation.logs / f"{LABEL}.err") in result.stderr
    assert installation.calls.count("health") == 100


def test_bad_plist_leaves_the_running_install_alone(installation: Installation) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    inode = installation.binary.stat().st_ino
    (installation.root / "invalid-plist").touch()
    second = installation.run()
    assert second.returncode == 1
    assert "the generated LaunchAgent plist is invalid" in second.stderr
    assert installation.binary.stat().st_ino == inode
    assert (installation.root / "loaded").is_file()
    assert f"bootout {SERVICE}" not in installation.calls
    assert installed(installation) == [installation.binary, installation.profile]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]


def test_failing_profile_validation_leaves_the_running_install_alone(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    inode = installation.binary.stat().st_ino
    profile = installation.profile.read_bytes()
    plist = installation.plist.read_bytes()
    (installation.root / "sandbox-fails").touch()
    second = installation.run()
    assert second.returncode == 1
    assert "does not run under the sandbox profile (status 1)" in second.stderr
    assert "stub failure" in second.stderr
    assert installation.binary.stat().st_ino == inode
    assert installation.profile.read_bytes() == profile
    assert installation.plist.read_bytes() == plist
    assert (installation.root / "loaded").is_file()
    assert f"bootout {SERVICE}" not in installation.calls
    assert installed(installation) == [installation.binary, installation.profile]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]


def test_installed_profile_is_the_repository_profile(
    installation: Installation,
) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    expected = (REPO / "gateway/gateway.sb").read_bytes()
    assert installation.profile.read_bytes() == expected
    assert installation.profile.stat().st_mode & 0o777 == 0o644
    _ = installation.profile.write_text("(version 1)\n")
    again = installation.run()
    assert again.returncode == 0, again.stderr
    assert installation.profile.read_bytes() == expected


def test_profile_parameters_match_the_plist(installation: Installation) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    used = set(
        re.findall(r'\(param "([A-Z_]+)"\)', (REPO / "gateway/gateway.sb").read_text())
    )
    assert used
    assert set(installation.parameters) == used
    validation = (installation.root / "sandbox-args").read_text().split("--\n")[0]
    assert {
        line.partition("=")[0] for line in validation.splitlines() if "=/" in line
    } == used


def profile_rules() -> list[str]:
    text = (REPO / "gateway/gateway.sb").read_text()
    rules: list[str] = []
    depth = 0
    start = 0
    in_string = False
    in_comment = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_comment:
            in_comment = character != "\n"
        elif in_string:
            if character == "\\":
                index += 1
            elif character == '"':
                in_string = False
        elif character == ";":
            in_comment = True
        elif character == '"':
            in_string = True
        elif character == "(":
            if depth == 0:
                start = index
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                rules.append(" ".join(text[start : index + 1].split()))
        index += 1
    return rules


def test_profile_denies_the_operations_that_deny_default_leaves_open() -> None:
    rules = profile_rules()
    assert "(version 1)" in rules
    assert "(deny file-link file-clone)" in rules
    hardware = [
        "nvram*",
        "iokit-get-properties",
        "iokit-open-service",
        "darwin-notification-post",
    ]
    for denied in (
        f"(deny {' '.join(hardware)})",
        '(deny mach-lookup (global-name "com.apple.system.notification_center"))',
        '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
        "(deny process-info*)",
        '(deny network-outbound (remote ip "localhost:*"))',
    ):
        assert denied in rules
        # system.sb allows some of what is denied here, and for one operation
        # the last matching rule wins.
        assert rules.index(denied) > rules.index('(import "system.sb")')
    assert "(allow process-info-pidinfo (target self))" in rules
    # The deny of the Mac's own addresses narrows the allow of port 443.
    assert rules.index('(allow network-outbound (remote tcp "*:443"))') < rules.index(
        '(deny network-outbound (remote ip "localhost:*"))'
    )
    assert not any(re.search(r"\bfile\*", rule) for rule in rules)
    assert "(system-network)" not in rules


def form(*parts: str) -> str:
    return f"({' '.join(parts)})"


STATE = '(param "STATE")'
SECRETS = '(param "SECRETS")'


def regex(directory: str, tail: str) -> str:
    return form("regex", f'(string-append "^" (regex-quote {directory}) "{tail}")')


SOCKET = regex(STATE, r"/sock/github-[0-9a-f-]+\\.sock$")
ADMIN = f'(literal (string-append {STATE} "/admin.sock"))'

GRANTS = [
    form("allow", "process-fork"),
    form(
        "allow",
        "process-exec",
        '(literal (param "BINARY"))',
        '(literal "/usr/bin/openssl")',
    ),
    form("allow", "file-read*", '(subpath "/private/etc/ssl")'),
    form("allow", "file-read-metadata", "(vnode-type SYMLINK)"),
    form(
        "allow",
        "file-read*",
        "file-write-mode",
        f"(literal {STATE})",
        f"(literal {SECRETS})",
    ),
    form(
        "allow",
        "file-read*",
        "file-write-mode",
        "file-write-create",
        f'(literal (string-append {STATE} "/sock"))',
    ),
    form(
        "allow",
        "file-read*",
        "file-write*",
        regex(STATE, r"/state\\.sqlite(-wal|-shm|-journal)?$"),
        SOCKET,
        ADMIN,
    ),
    form(
        "allow",
        "file-read*",
        "file-write*",
        regex(SECRETS, r"/((ca|ca-key|github|github-key)\\.pem|ca\\.srl)$"),
        regex(SECRETS, r"/\\.(lock|issue-[A-Za-z0-9]+(/[^/]+)?)$"),
        regex(
            SECRETS,
            r"/[A-Za-z0-9_-]+\\.json(\\.[0-9]+\\.[0-9]+\\.tmp|\\.lock)?$",
        ),
    ),
    form("allow", "file-read*", f'(subpath (string-append {SECRETS} "/claude-pool"))'),
    form("allow", "file-read*", '(literal (param "FIREWORKS_KEY"))'),
    form("allow", "network-bind", "network-inbound", SOCKET, ADMIN),
    form("allow", "network-outbound", '(remote tcp "*:443")'),
    form("allow", "network-outbound", '(literal "/private/var/run/mDNSResponder")'),
    form(
        "allow",
        "mach-lookup",
        '(global-name "com.apple.dnssd.service")',
        '(global-name "com.apple.SystemConfiguration.DNSConfiguration")',
    ),
    form("allow", "process-info-pidinfo", "(target self)"),
]


def test_profile_starts_from_deny_default_and_grants_only_what_was_reviewed() -> None:
    rules = profile_rules()
    assert rules[:3] == ["(version 1)", "(deny default)", '(import "system.sb")']
    assert [rule for rule in rules if rule.startswith("(allow")] == GRANTS


def test_profile_does_not_grant_whole_directories() -> None:
    rules = profile_rules()
    assert not any(
        re.search(r'\(subpath \(param "(STATE|SECRETS)"\)\)', rule) for rule in rules
    )
    assert "(allow file-read-metadata)" not in rules
    assert [rule for rule in rules if rule.startswith("(allow file-read-metadata")] == [
        "(allow file-read-metadata (vnode-type SYMLINK))"
    ]
    for rule in rules:
        if re.search(r'\(literal \(param "(STATE|SECRETS)"\)\)', rule):
            assert rule.startswith("(allow file-read* file-write-mode (literal")
        if '/sock"))' in rule and "(literal (string-append" in rule:
            assert not rule.startswith("(allow file-read* file-write*")
    pool = [rule for rule in rules if "claude-pool" in rule]
    assert len(pool) == 1
    assert pool[0].startswith("(allow file-read* (subpath")


def test_profile_denies_the_cli_credential_after_the_authorization_records() -> None:
    rules = profile_rules()
    records = next(
        index
        for index, rule in enumerate(rules)
        if rule.startswith("(allow file-read* file-write*") and "\\.json" in rule
    )
    deny = next(
        index
        for index, rule in enumerate(rules)
        if rule.startswith("(deny file-read* file-write*") and "tailscale-oauth" in rule
    )
    assert records < deny
    assert rules[deny] == (
        '(deny file-read* file-write* (regex (string-append "^" '
        '(regex-quote (param "SECRETS")) "/tailscale-oauth\\\\.json")))'
    )


def test_validation_runs_the_staged_files(installation: Installation) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    lines = (installation.root / "sandbox-args").read_text().splitlines()
    assert lines[0] == "-f"
    staged = Path(lines[1])
    assert staged != installation.profile
    assert staged.parent.name.startswith(".build.")
    assert lines[2:4] == ["-D", f"BINARY={staged.parent.resolve() / 'cog'}"]
    assert lines[-3:-1] == [str(staged.parent.resolve() / "cog"), "help"]


def test_fireworks_key_link_is_resolved(installation: Installation) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    elsewhere = installation.root / "elsewhere"
    elsewhere.mkdir()
    _ = (elsewhere / "key").write_text("word\n")
    (elsewhere / "hop").symlink_to("key")
    (secrets / "FIREWORKS_API_KEY").symlink_to(elsewhere / "hop")
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.parameters["FIREWORKS_KEY"] == str(elsewhere.resolve() / "key")


def test_missing_fireworks_key_uses_the_resolved_directory(
    installation: Installation,
) -> None:
    elsewhere = installation.root / "elsewhere"
    elsewhere.mkdir()
    (installation.home / ".config").symlink_to(elsewhere)
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.parameters["FIREWORKS_KEY"] == str(
        elsewhere.resolve() / "secrets/FIREWORKS_API_KEY"
    )


def test_created_directories_are_private_and_existing_ones_keep_their_modes(
    installation: Installation,
) -> None:
    kept = installation.home / ".local/state/cog"
    kept.mkdir(parents=True)
    kept.chmod(0o755)
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert kept.stat().st_mode & 0o777 == 0o755
    for relative in (
        ".config",
        ".config/secrets",
        ".config/secrets/cog",
    ):
        mode = (installation.home / relative).stat().st_mode & 0o777
        assert mode & 0o077 == 0, relative
    assert not (installation.home / ".lima").exists()


def test_linked_parents_and_home_are_resolved(installation: Installation) -> None:
    local = installation.root / "volume/local"
    config = installation.root / "volume/config"
    local.mkdir(parents=True)
    config.mkdir(parents=True)
    (installation.home / ".local").symlink_to(local)
    (installation.home / ".config").symlink_to(config)
    home_link = installation.root / "home link"
    home_link.symlink_to(installation.home)
    linked = Installation(installation.root, home_link)
    result = linked.run()
    assert result.returncode == 0, result.stderr
    assert linked.parameters == {
        "BINARY": str(local.resolve() / "share/cog/cog"),
        "STATE": str(local.resolve() / "state/cog"),
        "SECRETS": str(config.resolve() / "secrets/cog"),
        "FIREWORKS_KEY": str(config.resolve() / "secrets/FIREWORKS_API_KEY"),
    }
    arguments = linked.program_arguments
    assert arguments[2] == str(local.resolve() / "share/cog/gateway.sb")
    assert arguments[-3] == str(local.resolve() / "share/cog/cog")
    validation = (installation.root / "sandbox-args").read_text().split("--\n")[0]
    paths = [
        line.partition("=")[2] if "=/" in line else line
        for line in validation.splitlines()
        if line.startswith("/") or "=/" in line
    ]
    assert len(paths) == 6
    assert all(Path(path).resolve() == Path(path) for path in paths), paths


def test_control_character_in_fireworks_key_target_is_refused(
    installation: Installation,
) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    elsewhere = installation.root / "else\nwhere"
    elsewhere.mkdir()
    (secrets / "FIREWORKS_API_KEY").symlink_to(elsewhere / "key")
    result = installation.run()
    assert result.returncode == 1
    assert "without control characters" in result.stderr
    assert not installation.profile.exists()


def test_fireworks_key_link_loop_is_refused(installation: Installation) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    (secrets / "FIREWORKS_API_KEY").symlink_to("other")
    (secrets / "other").symlink_to("FIREWORKS_API_KEY")
    result = installation.run()
    assert result.returncode == 1
    assert "too many links" in result.stderr
    assert not installation.profile.exists()


def test_fireworks_key_link_to_a_top_level_path_is_resolved(
    installation: Installation,
) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    (secrets / "FIREWORKS_API_KEY").symlink_to("/etc")
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.parameters["FIREWORKS_KEY"] == str(Path("/etc").resolve())


def test_fireworks_key_link_that_climbs_to_the_root_is_resolved(
    installation: Installation,
) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    (secrets / "FIREWORKS_API_KEY").symlink_to("../" * 64 + "etc")
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.parameters["FIREWORKS_KEY"] == str(Path("/etc").resolve())


def test_trailing_newline_in_the_fireworks_key_target_is_refused(
    installation: Installation,
) -> None:
    secrets = installation.home / ".config/secrets"
    secrets.mkdir(parents=True)
    elsewhere = installation.root / "elsewhere"
    elsewhere.mkdir()
    target = elsewhere / "key\n"
    _ = target.write_text("word\n")
    (secrets / "FIREWORKS_API_KEY").symlink_to(target)
    result = installation.run()
    assert result.returncode == 1
    assert "without control characters" in result.stderr
    assert not installation.profile.exists()


def test_the_state_directory_is_private_when_it_is_created(
    installation: Installation,
) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    for relative in (".local/state", ".local/state/cog"):
        mode = (installation.home / relative).stat().st_mode & 0o777
        assert mode & 0o077 == 0, relative


def test_directory_at_the_profile_path_is_refused(installation: Installation) -> None:
    installation.profile.mkdir(parents=True)
    result = installation.run()
    assert result.returncode == 1
    assert "unexpected cog installation paths" in result.stderr
    assert not installation.calls


def test_missing_sandbox_exec_fails_before_installing(
    installation: Installation,
) -> None:
    (installation.tools / "sandbox-exec").unlink()
    result = installation.run()
    assert result.returncode == 1
    assert "macOS sandbox-exec is required" in result.stderr
    assert not installation.calls


def test_uninstall_keeps_data_and_does_not_need_bun(installation: Installation) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    retained = (
        installation.home / ".local/state/cog",
        installation.home / ".config/secrets/cog",
        installation.home / ".config/cog",
        installation.logs,
        installation.home / ".lima/cog-base",
    )
    for directory in retained:
        directory.mkdir(parents=True, exist_ok=True)
    (installation.tools / "bun").unlink()
    removed = installation.run("--uninstall", TEST_UNLOAD_DELAY="1")
    assert removed.returncode == 0, removed.stderr
    assert not installation.link.is_symlink()
    assert not installation.binary.parent.exists()
    assert not installation.plist.exists()
    assert not installation.profile.exists()
    assert not (installation.root / "loaded").exists()
    assert all(directory.is_dir() for directory in retained)
    assert all(str(directory) in removed.stdout for directory in retained[:-1])
    again = installation.run("--uninstall")
    assert again.returncode == 0, again.stderr


def test_missing_tool_names_its_homebrew_formula(installation: Installation) -> None:
    (installation.tools / "limactl").unlink()
    result = installation.run()
    assert result.returncode == 1
    assert "limactl is required; install the Homebrew formula lima" in result.stderr
    assert not installation.calls


def test_non_macos_fails_before_installing(installation: Installation) -> None:
    result = installation.run(TEST_OS="Linux")
    assert result.returncode == 1
    assert "macOS is required" in result.stderr
    assert not installation.calls


def test_unrelated_command_is_not_replaced_or_removed(
    installation: Installation,
) -> None:
    installation.link.parent.mkdir()
    _ = installation.link.write_text("unrelated\n")
    result = installation.run()
    assert result.returncode == 1
    assert "refusing to replace" in result.stderr
    assert not installation.calls
    removed = installation.run("--uninstall")
    assert removed.returncode == 0, removed.stderr
    assert installation.link.read_text() == "unrelated\n"


KEPT = ("cog.previous", "gateway.sb.previous")


def kept_copies(installation: Installation) -> list[Path]:
    return [
        *(installation.binary.parent / name for name in KEPT),
        installation.plist.with_name(f"{LABEL}.plist.previous"),
    ]


def snapshot(installation: Installation) -> tuple[bytes, bytes, bytes]:
    return (
        installation.binary.read_bytes(),
        installation.profile.read_bytes(),
        installation.plist.read_bytes(),
    )


def install_two_builds(installation: Installation) -> tuple[bytes, bytes, bytes]:
    _ = (installation.root / "build").write_text("one")
    first = installation.run()
    assert first.returncode == 0, first.stderr
    with installation.profile.open("a") as stream:
        _ = stream.write("; previous\n")
    with installation.plist.open("a") as stream:
        _ = stream.write("<!-- previous -->\n")
    previous = snapshot(installation)
    _ = (installation.root / "build").write_text("two")
    return previous


def test_healthy_install_leaves_no_kept_copies(installation: Installation) -> None:
    _ = install_two_builds(installation)
    second = installation.run()
    assert second.returncode == 0, second.stderr
    assert not any(path.exists() for path in kept_copies(installation))
    assert installed(installation) == [installation.binary, installation.profile]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]


def test_unhealthy_new_build_restores_the_previous_gateway(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    (installation.root / "unhealthy-two").touch()
    offset = len(installation.calls)
    second = installation.run()
    assert second.returncode == 1
    assert "the new build did not become healthy" in second.stderr
    assert "restored the previous gateway, which is healthy" in second.stderr
    assert str(installation.logs / f"{LABEL}.err") in second.stderr
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()
    calls = installation.calls[offset:]
    bootstraps = [c for c in calls if c.startswith("bootstrap")]
    assert bootstraps == [f"bootstrap {DOMAIN} {installation.plist}"] * 2
    assert calls.count(f"bootout {SERVICE}") == 2
    assert calls.count("health") == 101
    assert calls[-1] == "health"
    assert os.access(installation.binary, os.X_OK)
    assert installation.link.readlink() == installation.binary


def test_failed_bootstrap_of_the_new_agent_restores_the_previous_gateway(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    (installation.root / "bootstrap-fails-once").touch()
    second = installation.run()
    assert second.returncode == 1
    assert "installing the new build failed" in second.stderr
    assert "restored the previous gateway, which is healthy" in second.stderr
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()


def test_interrupt_while_the_previous_gateway_stops_starts_it_again(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="5", TEST_SIGNAL_AT="sleep:1")
    assert second.returncode == 1
    assert (
        "the install was interrupted; restored the previous gateway, which is healthy"
        in second.stderr
    )
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()
    calls = installation.calls[offset:]
    assert calls.count(f"bootout {SERVICE}") == 2
    assert calls[-2:] == [f"bootstrap {DOMAIN} {installation.plist}", "health"]
    assert not list(installation.binary.parent.glob(".build.*"))
    assert not list(installation.plist.parent.glob(".cog.*"))


def test_interrupt_while_the_previous_agent_is_booted_out_starts_it_again(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="5", TEST_SIGNAL_AT="bootout:1")
    assert second.returncode == 1
    assert (
        "the install was interrupted; restored the previous gateway, which is healthy"
        in second.stderr
    )
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()
    calls = installation.calls[offset:]
    assert calls.count(f"bootout {SERVICE}") == 2
    assert calls[-2:] == [f"bootstrap {DOMAIN} {installation.plist}", "health"]


def test_failed_bootout_of_the_previous_agent_starts_it_again(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    (installation.root / "bootout-fails-once").touch()
    offset = len(installation.calls)
    second = installation.run(TEST_UNLOAD_DELAY="5")
    assert second.returncode == 1
    assert (
        "stopping the previous gateway failed; restored the previous gateway, "
        "which is healthy"
    ) in second.stderr
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()
    calls = installation.calls[offset:]
    assert calls.count(f"bootout {SERVICE}") == 2
    assert calls[-2:] == [f"bootstrap {DOMAIN} {installation.plist}", "health"]


def test_interrupt_while_waiting_for_the_new_build_is_not_blamed_on_the_build(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    (installation.root / "unhealthy-two").touch()
    second = installation.run(TEST_SIGNAL_AT="sleep:1")
    assert second.returncode == 1
    assert "the install was interrupted; restored the previous gateway" in second.stderr
    assert "did not become healthy" not in second.stderr
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))


def test_a_second_interrupt_does_not_stop_the_rollback(
    installation: Installation,
) -> None:
    previous = install_two_builds(installation)
    (installation.root / "unhealthy-two").touch()
    second = installation.run(TEST_SIGNAL_AT="bootstrap:2", TEST_SIGNAL="TERM")
    assert second.returncode == 1
    assert "restored the previous gateway, which is healthy" in second.stderr
    assert snapshot(installation) == previous
    assert not any(path.exists() for path in kept_copies(installation))
    assert (installation.root / "loaded").is_file()
    assert not list(installation.binary.parent.glob(".build.*"))
    assert not list(installation.plist.parent.glob(".cog.*"))


def test_unhealthy_first_install_restores_nothing(installation: Installation) -> None:
    (installation.root / "unhealthy").touch()
    result = installation.run()
    assert result.returncode == 1
    assert "did not become healthy" in result.stderr
    assert "restored" not in result.stderr
    assert str(installation.logs / f"{LABEL}.err") in result.stderr
    assert installation.calls.count("health") == 100
    assert installation.calls.count(f"bootout {SERVICE}") == 0
    assert installation.binary.is_file()
    assert not any(path.exists() for path in kept_copies(installation))


def test_unhealthy_install_over_files_without_a_plist_leaves_no_kept_copies(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    installation.plist.unlink()
    (installation.root / "loaded").unlink()
    (installation.root / "unhealthy").touch()
    second = installation.run()
    assert second.returncode == 1
    assert "the new build did not become healthy" in second.stderr
    assert "restored" not in second.stderr
    assert not any(path.exists() for path in kept_copies(installation))


def test_unhealthy_predecessor_is_reported(installation: Installation) -> None:
    previous = install_two_builds(installation)
    (installation.root / "unhealthy-one").touch()
    (installation.root / "unhealthy-two").touch()
    second = installation.run()
    assert second.returncode == 1
    assert "the new build did not become healthy" in second.stderr
    assert "restoring the previous gateway also failed" in second.stderr
    assert "the previous gateway did not become healthy" in second.stderr
    assert "install.sh --uninstall" in second.stderr
    assert str(installation.logs / f"{LABEL}.err") in second.stderr
    assert snapshot(installation) == previous


def test_leftover_kept_copy_blocks_install_and_uninstall_removes_it(
    installation: Installation,
) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    leftover = installation.binary.with_name("cog.previous")
    _ = leftover.write_text("left by a killed run\n")
    plist_leftover = installation.plist.with_name(f"{LABEL}.plist.previous")
    _ = plist_leftover.write_text("left\n")
    blocked = installation.run()
    assert blocked.returncode == 1
    assert "interrupted" in blocked.stderr
    removed = installation.run("--uninstall")
    assert removed.returncode == 0, removed.stderr
    assert not leftover.exists()
    assert not plist_leftover.exists()
    assert not installation.binary.parent.exists()


def staging_directories(installation: Installation) -> list[Path]:
    return [
        *installation.binary.parent.glob(".build.*"),
        *installation.plist.parent.glob(".cog.*"),
    ]


# Bash 5 ignores SIGQUIT, so only SIGKILL ends the installer on every platform.
KILLS = {
    "during the build": {"TEST_SIGNAL_AT": "build:1", "TEST_SIGNAL": "KILL"},
    "while the previous gateway stops": {
        "TEST_SIGNAL_AT": "sleep:1",
        "TEST_SIGNAL": "KILL",
        "TEST_UNLOAD_DELAY": "5",
    },
    "while the new agent starts": {
        "TEST_SIGNAL_AT": "bootstrap:1",
        "TEST_SIGNAL": "KILL",
    },
}


@pytest.mark.parametrize("overrides", KILLS.values(), ids=KILLS.keys())
def test_uninstall_removes_what_a_killed_install_left(
    installation: Installation, overrides: dict[str, str]
) -> None:
    _ = install_two_builds(installation)
    killed = installation.run(**overrides)
    assert killed.returncode < 0
    assert len(staging_directories(installation)) == 2
    removed = installation.run("--uninstall")
    assert removed.returncode == 0, removed.stderr
    assert not installation.binary.parent.exists()
    assert list(installation.plist.parent.iterdir()) == []
    assert not installation.link.is_symlink()
    assert str(installation.logs) in removed.stdout
    again = installation.run("--uninstall")
    assert again.returncode == 0, again.stderr


def test_uninstall_keeps_a_file_it_did_not_create(installation: Installation) -> None:
    first = installation.run()
    assert first.returncode == 0, first.stderr
    notes = installation.binary.parent / "notes"
    _ = notes.write_text("not ours\n")
    removed = installation.run("--uninstall")
    assert removed.returncode == 1
    assert "not empty" in removed.stderr
    assert notes.read_text() == "not ours\n"
