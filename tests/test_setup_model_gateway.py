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
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "guest/setup-model-gateway"
GITHUB = "127.0.0.1 github.com api.github.com # cog"
CLAUDE = "127.0.0.1 api.anthropic.com # cog"
HOSTS = f"127.0.0.1 localhost\n{GITHUB}\n"


@pytest.fixture
def guest(tmp_path: Path) -> Path:
    (tmp_path / "etc").mkdir()
    _ = (tmp_path / "etc/hosts").write_text(HOSTS)
    lib = tmp_path / "lib"
    lib.mkdir()
    # A relative etc path confines the hosts file to the fixture.
    _ = (lib / SCRIPT.name).write_text(SCRIPT.read_text().replace("/etc/", "etc/"))
    shim = lib / "id"
    _ = shim.write_text('#!/bin/sh\n[ "$1" = -u ] && echo "$FAKE_UID"\n')
    shim.chmod(0o755)
    return tmp_path


def run(guest: Path, *args: str, uid: str = "0") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "lib/setup-model-gateway", *args],
        cwd=guest,
        env={
            "PATH": f"{guest / 'lib'}:{os.environ['PATH']}",
            "FAKE_UID": uid,
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_claude_adds_its_line_once_and_keeps_the_github_line(guest: Path) -> None:
    for _ in range(2):
        result = run(guest, "claude")
        assert result.returncode == 0, result.stderr
        assert (guest / "etc/hosts").read_text() == f"{HOSTS}{CLAUDE}\n"
    result = run(guest, "claude", "claude")
    assert result.returncode == 0, result.stderr
    assert (guest / "etc/hosts").read_text() == f"{HOSTS}{CLAUDE}\n"


def test_claude_starts_a_new_line_after_an_unterminated_hosts_file(
    guest: Path,
) -> None:
    _ = (guest / "etc/hosts").write_text("127.0.0.1 localhost")
    result = run(guest, "claude")
    assert result.returncode == 0, result.stderr
    assert (guest / "etc/hosts").read_text() == f"127.0.0.1 localhost\n{CLAUDE}\n"


def test_a_line_that_only_resembles_the_mapping_does_not_stand_in_for_it(
    guest: Path,
) -> None:
    lookalikes = (
        f"#{CLAUDE}\n{CLAUDE} extra\n {CLAUDE}\n{CLAUDE.replace('.', 'x', 3)}\n"
    )
    _ = (guest / "etc/hosts").write_text(f"{HOSTS}{lookalikes}")
    result = run(guest, "claude")
    assert result.returncode == 0, result.stderr
    assert (guest / "etc/hosts").read_text() == f"{HOSTS}{lookalikes}{CLAUDE}\n"


def test_a_missing_hosts_file_is_an_error_and_is_not_created(guest: Path) -> None:
    (guest / "etc/hosts").unlink()
    result = run(guest, "claude")
    assert result.returncode != 0
    assert result.stderr.startswith("setup-model-gateway: ")
    assert "cannot read" in result.stderr
    assert not (guest / "etc/hosts").exists()


@pytest.mark.parametrize(
    ("args", "uid", "message"),
    [
        ([], "0", "expected one or more model names"),
        (["gemini"], "0", "unknown model gemini"),
        (["claude", "gemini"], "0", "unknown model gemini"),
        (["claude"], "1000", "run as root"),
        (["claude"], "", "run as root"),
    ],
)
def test_refusals_change_nothing(
    guest: Path, args: list[str], uid: str, message: str
) -> None:
    result = run(guest, *args, uid=uid)
    assert result.returncode != 0
    assert result.stderr.startswith("setup-model-gateway: ")
    assert message in result.stderr
    assert (guest / "etc/hosts").read_text() == HOSTS
