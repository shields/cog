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

import json
import os
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

GUEST = Path(__file__).resolve().parents[1] / "guest"
PUSH_RULES = [
    "Bash(git push*)",
    "Bash(git -C * push*)",
    "Bash(git -c * push*)",
    "Bash(git --git-dir* push*)",
    "Bash(git --work-tree* push*)",
]
OTHER_RULES = ["Bash(git commit*)", "Bash(gh pr merge*)", "Read(~/.ssh/**)"]
SETTINGS = Path("etc/claude-code/managed-settings.json")
MARKER = Path("etc/cog-gateway")


@pytest.fixture
def guest(tmp_path: Path) -> Path:
    (tmp_path / SETTINGS.parent).mkdir(parents=True)
    (tmp_path / "home/.codex/rules").mkdir(parents=True)
    (tmp_path / "home/.codex/rules/no-push.rules").touch()
    lib = tmp_path / "lib"
    lib.mkdir()
    script = GUEST / "configure-github-access.sh"
    # Relative etc paths confine the guest's system settings to the fixture.
    _ = (lib / script.name).write_text(script.read_text().replace("/etc/", "etc/"))
    _ = shutil.copy2(GUEST / "github-gateway-credential", lib)
    for name, body in {
        "id": '[ "$1" = -u ] && echo 0',
        "getent": '[ "$*" = "passwd tester" ] && echo "tester:x:42:42::$HOME:/bin/sh"',
        "sudo": '[ "$1 $2 $3" = "-H -u tester" ] || exit 1\nshift 3\nexec "$@"',
    }.items():
        shim = lib / name
        _ = shim.write_text(f"#!/bin/sh\n{body}\n")
        shim.chmod(0o755)
    return tmp_path


def run(
    guest: Path, *args: str, stdin: str | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=guest,
        env={
            "HOME": str(guest / "home"),
            "PATH": f"{guest / 'lib'}:{os.environ['PATH']}",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
        },
        input=stdin,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def configure(
    guest: Path, marker: str, settings: dict[str, object]
) -> subprocess.CompletedProcess[str]:
    _ = (guest / SETTINGS).write_text(json.dumps(settings))
    return run(guest, "bash", "lib/configure-github-access.sh", "tester", marker)


def test_managed_push_instructions(guest: Path) -> None:
    (guest / "etc/codex").mkdir()
    script = GUEST / "install-push-instructions.sh"
    installer = guest / "lib" / script.name
    _ = installer.write_text(script.read_text().replace("/etc/", "etc/"))
    claude = guest / "etc/claude-code/CLAUDE.md"
    codex = guest / "etc/codex/requirements.toml"
    vm_id = "46548c62-8ea4-4c8a-b09d-070a70d5844c"
    result = run(guest, "bash", str(installer), vm_id)
    assert result.returncode == 0, result.stderr
    instructions = claude.read_text()
    assert (
        tomllib.loads(codex.read_text())["additional_developer_instructions"]
        == instructions
    )
    assert f"`cog/{vm_id}/NAME`" in instructions
    assert "VM-ID" not in instructions
    before_push = instructions.index("Before every push")
    assert (
        before_push
        < instructions.index("rebase", before_push)
        < instructions.index("git push")
    )
    assert claude.stat().st_mode & 0o777 == codex.stat().st_mode & 0o777 == 0o644

    invalid = run(guest, "bash", str(installer), "cloudflare")
    assert invalid.returncode != 0
    assert "expected the VM instance ID" in invalid.stderr
    assert claude.read_text() == instructions
    assert (
        tomllib.loads(codex.read_text())["additional_developer_instructions"]
        == instructions
    )


@pytest.mark.parametrize(
    "marker", ["cloudflare", "46548c62-8ea4-4c8a-b09d-070a70d5844c"]
)
def test_gateway_access(guest: Path, marker: str) -> None:
    home = guest / "home"
    config = home / ".config/git/config"
    config.parent.mkdir(parents=True)
    _ = config.write_text(
        """[credential "https://gist.github.com"]
    helper = !gh auth git-credential
[credential "https://github.com"]
    helper = !stale
    helper = !other
"""
    )
    gitconfig = home / ".gitconfig"
    original = "[user]\n\tname = Someone\n"
    _ = gitconfig.write_text(original)
    like_push = ["Bash(git push)", "Bash(git push*) ", "Bash(git -C * push)"]
    settings: dict[str, object] = {
        "permissions": {"deny": [*OTHER_RULES, *PUSH_RULES, *like_push]},
        "sandbox": {"enabled": False},
    }
    result = configure(guest, marker, settings)
    assert result.returncode == 0, result.stderr
    assert json.loads((guest / SETTINGS).read_text()) == {
        **settings,
        "permissions": {"deny": [*OTHER_RULES, *like_push]},
    }
    assert (guest / SETTINGS).stat().st_mode & 0o777 == 0o644
    assert (guest / MARKER).read_text() == f"{marker}\n"
    assert (guest / MARKER).stat().st_mode & 0o777 == 0o644
    assert not (guest / ("etc/cog-" + "github-gateway")).exists()
    assert not (home / ".codex/rules/no-push.rules").exists()
    assert gitconfig.read_text() == original
    for host, helper in {
        "gist.github.com": "!gh auth git-credential",
        "github.com": f"!{guest / 'lib/github-gateway-credential'}",
    }.items():
        read = run(
            guest,
            "git",
            "config",
            "--file",
            str(config),
            "--get-all",
            f"credential.https://{host}.helper",
        )
        assert read.stdout.splitlines() == [helper]
    filled = run(
        guest, "git", "credential", "fill", stdin="protocol=https\nhost=github.com\n\n"
    )
    assert filled.returncode == 0, filled.stderr
    assert "password=cog" in filled.stdout.splitlines()


def test_a_partial_rule_set_and_a_fresh_home(guest: Path) -> None:
    result = configure(
        guest, "cloudflare", {"permissions": {"deny": [PUSH_RULES[0], *OTHER_RULES]}}
    )
    assert result.returncode == 0, result.stderr
    assert json.loads((guest / SETTINGS).read_text()) == {
        "permissions": {"deny": OTHER_RULES}
    }
    assert (guest / "home/.config/git/config").is_file()
    assert not (guest / "home/.gitconfig").exists()


@pytest.mark.parametrize(
    "settings",
    [
        {"permissions": {"deny": OTHER_RULES}},
        {"permissions": {"deny": []}},
        {"permissions": {}},
        {},
    ],
)
def test_missing_push_rules_stop_setup(
    guest: Path, settings: dict[str, object]
) -> None:
    result = configure(guest, "cloudflare", settings)
    assert result.returncode != 0
    assert "cannot remove the git push deny rules" in result.stderr
    assert json.loads((guest / SETTINGS).read_text()) == settings
    assert (guest / "home/.codex/rules/no-push.rules").exists()
    assert not (guest / MARKER).exists()
