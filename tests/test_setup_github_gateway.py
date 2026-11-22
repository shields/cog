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

# guest/setup-github-gateway edits root-owned files in a VM, so it cannot run
# here. These tests run the jq program that it applies to the managed settings.

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
SCRIPT = REPO / "guest" / "setup-github-gateway"

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


def program() -> str:
    match = re.search(r"\njq '(.*?)' \\\n", SCRIPT.read_text(), re.DOTALL)
    assert match, "the jq program is missing from setup-github-gateway"
    return match.group(1)


def filter_settings(
    settings: Mapping[str, object],
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["jq", program()],
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


def test_exactly_the_five_push_rules_are_removed() -> None:
    settings = {
        "permissions": {"deny": [*OTHER_RULES[:1], *PUSH_RULES, *OTHER_RULES[1:]]},
        "sandbox": {"enabled": False},
    }
    result = filter_settings(settings)
    assert deny_after(result) == OTHER_RULES
    assert json.loads(result.stdout)["sandbox"] == {"enabled": False}


def test_a_rule_like_a_push_rule_but_not_identical_stays() -> None:
    lookalikes = ["Bash(git push)", "Bash(git push*) ", "Bash(git -C * push)"]
    result = filter_settings({"permissions": {"deny": [*PUSH_RULES, *lookalikes]}})
    assert deny_after(result) == lookalikes


def test_a_partial_set_is_still_removed() -> None:
    result = filter_settings({"permissions": {"deny": [PUSH_RULES[0], *OTHER_RULES]}})
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
def test_settings_without_a_push_rule_fail(settings: Mapping[str, object]) -> None:
    result = filter_settings(settings)
    assert result.returncode != 0
    assert result.stdout == ""
