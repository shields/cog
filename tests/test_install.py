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
case ${0##*/} in
    uname) printf '%s\n' "${TEST_OS:-Darwin}" ;;
    sleep) printf 'sleep %s\n' "$*" >> "$TEST_STATE/calls" ;;
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
            printf '#!/bin/bash\nexec "$TEST_STATE/bin/health" "$@"\n' > "$7"
            chmod +x "$7"
        fi
        ;;
    sandbox-exec)
        [[ $(pwd -P) == / && $PATH == /usr/bin:/bin:/usr/sbin:/sbin &&
            -z ${COG_ROOT+x}${COG_BASE+x} ]] || exit 1
        printf 'sandbox-exec\n' >> "$TEST_STATE/calls"
        { printf '%s\n' "$@"; printf -- '--\n'; } >> "$TEST_STATE/sandbox-args"
        [[ $1 == -f && -f $2 && $# == 14 && $3 == -D && $4 == BINARY=/* ]] || exit 1
        binary=${4#BINARY=}
        cmp -s "$2" "$TEST_REPO/gateway/gateway.sb"
        shift 2
        for _ in 1 2 3 4 5; do
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
                ;;
            bootstrap)
                [[ $# == 3 && $2 == "$TEST_DOMAIN" && -f $3 &&
                    ! -e $TEST_STATE/loaded ]] || exit 1
                python3 -I -c '
import os, plistlib, sys
arguments = plistlib.load(open(sys.argv[1], "rb"))["ProgramArguments"]
sys.exit(not (
    arguments[:2] == ["/usr/bin/sandbox-exec", "-f"]
    and os.path.isfile(arguments[2])
    and open(arguments[2], "rb").read() == open(sys.argv[2], "rb").read()
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
        [[ -f $TEST_STATE/loaded && ! -f $TEST_STATE/unhealthy ]] || exit 1
        ;;
    *) exit 2 ;;
esac
"""


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
            timeout=30,
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
                f"LIMA={real / '.lima'}",
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
            "ExitTimeOut": 5,
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
    second = installation.run(TEST_UNLOAD_DELAY="500")
    assert second.returncode == 1
    assert "timed out waiting for" in second.stderr
    assert installation.calls[offset:].count("sleep 0.1") == 150
    assert installation.binary.stat().st_ino == inode
    assert not any(call.startswith("bootstrap") for call in installation.calls[offset:])


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
    assert second.returncode != 0
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


def test_lima_directory_link_is_resolved_from_lima_home(
    installation: Installation,
) -> None:
    target = installation.root / "volume/lima"
    target.mkdir(parents=True)
    link = installation.root / "lima link"
    link.symlink_to(target)
    result = installation.run(LIMA_HOME=str(link))
    assert result.returncode == 0, result.stderr
    assert installation.parameters["LIMA"] == str(target.resolve())


def test_lima_directory_link_is_resolved_from_the_default(
    installation: Installation,
) -> None:
    target = installation.root / "volume/.lima"
    target.mkdir(parents=True)
    (installation.home / ".lima").symlink_to(target)
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.parameters["LIMA"] == str(target.resolve())


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
        ".lima",
    ):
        mode = (installation.home / relative).stat().st_mode & 0o777
        assert mode & 0o077 == 0, relative


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
        "LIMA": str(installation.home.resolve() / ".lima"),
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
    assert len(paths) == 7
    assert all(Path(path).resolve() == Path(path) for path in paths), paths


def test_control_character_in_lima_home_is_refused(installation: Installation) -> None:
    result = installation.run(LIMA_HOME=str(installation.root / "lima\nhome"))
    assert result.returncode == 1
    assert "without control characters" in result.stderr
    assert not installation.calls


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


def test_trailing_newline_in_the_lima_directory_is_refused(
    installation: Installation,
) -> None:
    target = installation.root / "volume/lima\n"
    target.mkdir(parents=True)
    link = installation.root / "lima link"
    link.symlink_to(target)
    result = installation.run(LIMA_HOME=str(link))
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


def test_relative_lima_home_is_refused(installation: Installation) -> None:
    result = installation.run(LIMA_HOME="lima")
    assert result.returncode == 1
    assert "LIMA_HOME must be an absolute path" in result.stderr
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
