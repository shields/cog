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

# guest/setup-github-gateway and cloudflare/guest/agent.sh edit root-owned files
# in a guest, so they cannot run here. These tests run the jq program that each
# applies to the managed settings, and the lines that write the credential
# helper, in a scratch home under a sudo shim.

import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, cast, final

import pytest

if TYPE_CHECKING:
    from collections.abc import Mapping

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = (
    REPO / "guest" / "setup-github-gateway",
    REPO / "cloudflare" / "guest" / "agent.sh",
)

PUSH_RULES = [
    "Bash(git push*)",
    "Bash(git -C * push*)",
    "Bash(git -c * push*)",
    "Bash(git --git-dir* push*)",
    "Bash(git --work-tree* push*)",
]
OTHER_RULES = ["Bash(git commit*)", "Bash(gh pr merge*)", "Read(~/.ssh/**)"]


@pytest.fixture(autouse=True)
def _jq_is_installed() -> None:
    if shutil.which("jq") is None:
        pytest.fail("jq is required")


@pytest.fixture(params=SCRIPTS, ids=[script.name for script in SCRIPTS])
def script(request: pytest.FixtureRequest) -> Path:
    return cast("Path", request.param)


def program(script: Path) -> str:
    match = re.search(r"\njq '(.*?)' \\\n", script.read_text(), re.DOTALL)
    assert match, f"the jq program is missing from {script.name}"
    return match.group(1)


def filter_settings(
    script: Path, settings: Mapping[str, object]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["jq", program(script)],
        input=json.dumps(settings),
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )


def deny_after(result: subprocess.CompletedProcess[str]) -> list[str]:
    assert result.returncode == 0, result.stderr
    out = cast("dict[str, dict[str, list[str]]]", json.loads(result.stdout))
    return out["permissions"]["deny"]


def test_both_scripts_apply_the_same_program() -> None:
    assert len({program(script) for script in SCRIPTS}) == 1


def test_exactly_the_five_push_rules_are_removed(script: Path) -> None:
    settings = {
        "permissions": {"deny": [*OTHER_RULES[:1], *PUSH_RULES, *OTHER_RULES[1:]]},
        "sandbox": {"enabled": False},
    }
    result = filter_settings(script, settings)
    assert deny_after(result) == OTHER_RULES
    assert json.loads(result.stdout)["sandbox"] == {"enabled": False}


def test_a_rule_like_a_push_rule_but_not_identical_stays(script: Path) -> None:
    lookalikes = ["Bash(git push)", "Bash(git push*) ", "Bash(git -C * push)"]
    result = filter_settings(
        script, {"permissions": {"deny": [*PUSH_RULES, *lookalikes]}}
    )
    assert deny_after(result) == lookalikes


def test_a_partial_set_is_still_removed(script: Path) -> None:
    result = filter_settings(
        script, {"permissions": {"deny": [PUSH_RULES[0], *OTHER_RULES]}}
    )
    assert deny_after(result) == OTHER_RULES


@pytest.mark.parametrize(
    "settings",
    [
        {"permissions": {"deny": OTHER_RULES}},
        {"permissions": {"deny": []}},
        {"permissions": {}},
        {},
    ],
)
def test_settings_without_a_push_rule_fail(
    script: Path, settings: Mapping[str, object]
) -> None:
    result = filter_settings(script, settings)
    assert result.returncode != 0
    assert result.stdout == ""


SUDO_LINE = re.compile(r"^sudo -H -u .*$", re.MULTILINE)
GIST_HELPER = "!gh auth git-credential"


def sudo_lines(script: Path) -> str:
    lines = cast("list[str]", SUDO_LINE.findall(script.read_text()))
    assert len(lines) == 2, f"expected the mkdir and the git config in {script.name}"
    assert all("--global" not in line for line in lines)
    return "\n".join(lines)


HELPER_SCRIPT = """#!/bin/sh
[ "$1" = get ] || exit 0
printf 'username=cog\\npassword=dummy\\n'
"""


@final
class Guest:
    def __init__(self, root: Path) -> None:
        self.home: Path = root / "home"
        self.lib: Path = root / "lib"
        self.home.mkdir()
        self.lib.mkdir()
        self.helper: Path = self.lib / "github-gateway-credential"
        _ = self.helper.write_text(HELPER_SCRIPT)
        self.helper.chmod(0o755)
        self.config: Path = self.home / ".config" / "git" / "config"
        self.gitconfig: Path = self.home / ".gitconfig"
        self.env: dict[str, str] = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }

    def git(
        self, *args: str, stdin: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env=self.env,
            input=stdin,
        )

    def run(self, script: Path) -> None:
        variables = {
            "SUDO_USER": "guest",
            "user": "guest",
            "guest_home": str(self.home),
            "home": str(self.home),
            "lib_dir": str(self.lib),
            "helper": str(self.helper),
        }
        assignments = "\n".join(f"{k}={shlex.quote(v)}" for k, v in variables.items())
        body = (
            'sudo() { [ "$1 $2" = "-H -u" ] && shift 3 && "$@"; }\n'
            f"{assignments}\n{sudo_lines(script)}\n"
        )
        result = subprocess.run(
            ["bash", "-euo", "pipefail", "-c", body],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env=self.env,
        )
        assert result.returncode == 0, result.stderr

    def helper_values(self, key: str) -> list[str]:
        result = self.git("config", "--file", str(self.config), "--get-all", key)
        return result.stdout.splitlines()


@pytest.fixture
def guest(tmp_path: Path) -> Guest:
    return Guest(tmp_path)


def test_the_helper_goes_in_the_xdg_config_not_gitconfig(
    script: Path, guest: Guest
) -> None:
    _ = guest.gitconfig.write_text("[user]\n\tname = Someone\n")
    before = guest.gitconfig.read_bytes()
    guest.run(script)
    assert guest.gitconfig.read_bytes() == before
    assert guest.helper_values("credential.https://github.com.helper") == [
        f"!{guest.helper}"
    ]
    filled = guest.git(
        "credential", "fill", stdin="protocol=https\nhost=github.com\n\n"
    )
    assert filled.returncode == 0, filled.stderr
    assert "password=dummy" in filled.stdout.splitlines()


def test_no_gitconfig_is_created(script: Path, guest: Guest) -> None:
    guest.run(script)
    assert not guest.gitconfig.exists()


def test_the_gist_helper_is_left_alone(script: Path, guest: Guest) -> None:
    guest.config.parent.mkdir(parents=True)
    _ = guest.config.write_text(
        f"""[credential "https://gist.github.com"]
\thelper = {GIST_HELPER}
[credential "https://github.com"]
\thelper = !stale
"""
    )
    guest.run(script)
    assert guest.helper_values("credential.https://gist.github.com.helper") == [
        GIST_HELPER
    ]
    assert guest.helper_values("credential.https://github.com.helper") == [
        f"!{guest.helper}"
    ]


def test_a_second_run_changes_nothing(script: Path, guest: Guest) -> None:
    guest.run(script)
    first = guest.config.read_bytes()
    guest.run(script)
    assert guest.config.read_bytes() == first
    assert len(guest.helper_values("credential.https://github.com.helper")) == 1


def test_a_missing_config_directory_is_created(script: Path, guest: Guest) -> None:
    assert not guest.config.parent.exists()
    guest.run(script)
    assert guest.config.is_file()
