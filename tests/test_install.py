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

import os
import plistlib
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

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
        [[ $# == 2 && $1 == -lint ]]
        printf 'lint\n' >> "$TEST_STATE/calls"
        [[ ! -f "$TEST_STATE/invalid-plist" ]] || exit 1
        python3 -I -c \
            'import plistlib, sys; plistlib.load(open(sys.argv[1], "rb"))' "$2"
        ;;
    bun)
        [[ $(pwd -P) == "$TEST_REPO" ]]
        if [[ $1 == install ]]; then
            [[ $# == 2 && $2 == --frozen-lockfile ]]
            printf 'install deps\n' >> "$TEST_STATE/calls"
        else
            [[ $# == 7 && $1 == build && $2 == --compile &&
                $3 == --no-compile-autoload-dotenv &&
                $4 == --no-compile-autoload-bunfig &&
                $5 == cog/main.ts && $6 == --outfile ]]
            printf 'build\n' >> "$TEST_STATE/calls"
            printf '#!/bin/bash\nexec "$TEST_STATE/bin/health" "$@"\n' > "$7"
            chmod +x "$7"
        fi
        ;;
    launchctl)
        printf '%s\n' "$*" >> "$TEST_STATE/calls"
        case $1 in
            print)
                [[ $# == 2 && $2 == "$TEST_SERVICE" ]]
                if [[ -f $TEST_STATE/unloading ]]; then
                    remaining=$(<"$TEST_STATE/unloading")
                    if (( remaining == 0 )); then
                        rm "$TEST_STATE/unloading" "$TEST_STATE/loaded"
                    else
                        printf '%s\n' "$((remaining - 1))" > "$TEST_STATE/unloading"
                    fi
                fi
                [[ -f $TEST_STATE/loaded ]]
                ;;
            bootout)
                [[ $# == 2 && $2 == "$TEST_SERVICE" && -f $TEST_STATE/loaded ]]
                printf '%s\n' "${TEST_UNLOAD_DELAY:-0}" > "$TEST_STATE/unloading"
                ;;
            bootstrap)
                [[ $# == 3 && $2 == "$TEST_DOMAIN" && -f $3 &&
                    ! -e $TEST_STATE/loaded ]]
                : > "$TEST_STATE/loaded"
                ;;
            *) exit 2 ;;
        esac
        ;;
    health)
        [[ $# == 2 && $* == 'gateway health' && -z ${COG_ROOT+x}${COG_BASE+x} ]]
        printf 'health\n' >> "$TEST_STATE/calls"
        [[ -f $TEST_STATE/loaded && ! -f $TEST_STATE/unhealthy ]]
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
    def logs(self) -> Path:
        return self.home / "Library/Logs"

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
    for name in ("uname", "sleep", "plutil", "bun", "launchctl", "health"):
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


def test_first_install(installation: Installation) -> None:
    result = installation.run()
    assert result.returncode == 0, result.stderr
    assert installation.calls == [
        "install deps",
        "build",
        "lint",
        f"print {SERVICE}",
        f"bootstrap {DOMAIN} {installation.plist}",
        "health",
    ]
    assert installation.link.readlink() == installation.binary
    assert os.access(installation.binary, os.X_OK)
    assert installation.logs.is_dir()
    assert list(installation.binary.parent.iterdir()) == [installation.binary]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]
    with installation.plist.open("rb") as stream:
        assert plistlib.load(stream) == {
            "Label": LABEL,
            "ProgramArguments": [str(installation.binary), "gateway", "serve"],
            "RunAtLoad": True,
            "KeepAlive": True,
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
    assert list(installation.binary.parent.iterdir()) == [installation.binary]
    assert list(installation.plist.parent.iterdir()) == [installation.plist]


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
