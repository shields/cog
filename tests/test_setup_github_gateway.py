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
# applies to the managed settings.

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, cast

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
