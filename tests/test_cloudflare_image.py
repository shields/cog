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

import hashlib
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO / "cloudflare/Dockerfile"
DOTFILES_IN_IMAGE = "/home/shields/src/github.com/shields/dotfiles"

GLOBAL_CONFIG = """\
[user]
    name = Test User
    email = test@example.com
[init]
    defaultBranch = main
[protocol "file"]
    allow = always
[maintenance]
    auto = false
[gc]
    auto = 0
"""

MARKER_READERS = {
    ".zshrc": "/etc/cog-throwaway /etc/cog-gateway\n",
    ".zshenv": "/etc/cog-gateway\n",
    ".zsh.d/wt.zsh": "/etc/cog-gateway\n",
    ".codex/hooks/git_guard.py": "/etc/cog-gateway\n",
    "tools/configure_codex.py": "/etc/cog-throwaway\n",
    "provision.sh": "#!/bin/sh\n# /etc/cog-gateway\n",
    ".claude/statusline.sh": "#!/bin/bash\n# /etc/cog-gateway\n",
}

BUNX_STUB = """\
#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >"$STUB_LOG/bunx-args"
config=
secrets=
while (($#)); do
    case $1 in
    --config)
        config=$2
        shift
        ;;
    --secrets-file)
        secrets=$2
        shift
        ;;
    esac
    shift
done
cp "$config" "$STUB_LOG/config.json"
head -c 12 "$secrets" >"$STUB_LOG/secrets-prefix"
ls -ld "$secrets" | cut -c1-10 >"$STUB_LOG/secrets-mode"
context=$(jq -r '.containers[0].images.base.build_context' "$config")
cd "$context"
for dir in . guest cloudflare; do
    ls -ld "$dir" | cut -c1-10
done >"$STUB_LOG/context-modes"
find . -path ./dotfiles -prune -o -print | LC_ALL=C sort >"$STUB_LOG/context-list"
if [[ -f dotfiles/provision.sh ]]; then : >"$STUB_LOG/has-dotfiles"; fi
"""

BUN_STUB = """\
#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >>"$STUB_LOG/bun-args"
"""


def planted_secret() -> str:
    return "ghp_" + hashlib.sha256(b"cloudflare image secret").hexdigest()[:36]


def git(env: dict[str, str], cwd: Path, *args: str) -> None:
    _ = subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )


def jq(file: Path, expression: str) -> str:
    result = subprocess.run(
        ["jq", "-r", expression, str(file)],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return result.stdout.strip()


@dataclass(frozen=True)
class World:
    base: Path
    cog: Path
    dotfiles: Path
    home: Path
    stubs: Path
    log: Path
    env: dict[str, str]

    def run(
        self, *argv: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(argv),
            cwd=self.base,
            env={**self.env, **(env or {})},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )

    def context(self, dest: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return self.run(
            str(self.cog / "cloudflare/context.sh"),
            str(dest),
            "--dotfiles",
            str(self.dotfiles),
            *args,
        )

    def deploy(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.run(str(self.cog / "cloudflare/deploy.sh"), *args)

    def commit(self, repo: Path) -> None:
        git(self.env, repo, "add", "-A")
        git(self.env, repo, "commit", "-q", "-m", "commit")


@pytest.fixture
def world(tmp_path: Path) -> World:
    base = tmp_path.resolve()
    config = base / "gitconfig"
    _ = config.write_text(GLOBAL_CONFIG)
    home = base / "home"
    (home / ".ssh").mkdir(parents=True)
    _ = (home / ".ssh/id_ed25519.pub").write_text("ssh-ed25519 AAAAtest owner\n")
    stubs = base / "stubs"
    stubs.mkdir()
    for name, text in (("bun", BUN_STUB), ("bunx", BUNX_STUB)):
        _ = (stubs / name).write_text(text)
        (stubs / name).chmod(0o755)
    log = base / "log"
    log.mkdir()
    tmpdir = base / "tmp"
    tmpdir.mkdir()
    env = {
        "PATH": f"{stubs}:{os.environ['PATH']}",
        "HOME": str(home),
        "TMPDIR": str(tmpdir),
        "STUB_LOG": str(log),
        "GIT_CONFIG_GLOBAL": str(config),
        "GIT_CONFIG_NOSYSTEM": "1",
    }

    cog = base / "cog"
    for name in (
        "tools/stage_tree.sh",
        "cloudflare/context.sh",
        "cloudflare/deploy.sh",
        "cloudflare/Dockerfile",
        "cloudflare/wrangler.jsonc",
    ):
        target = cog / name
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = shutil.copy2(REPO / name, target)
    _ = shutil.copytree(
        REPO / "cloudflare/guest",
        cog / "cloudflare/guest",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    _ = shutil.copytree(
        REPO / "guest", cog / "guest", ignore=shutil.ignore_patterns("__pycache__")
    )
    for pycache in (cog / "guest/__pycache__", cog / "cloudflare/guest/__pycache__"):
        pycache.mkdir()
        _ = (pycache / "stray.cpython-313.pyc").write_bytes(b"\0")
    git(env, base, "init", "-q", str(cog))

    dotfiles = base / "dotfiles"
    dotfiles.mkdir()
    for name, text in {**MARKER_READERS, ".claude/settings.json": "{}\n"}.items():
        target = dotfiles / name
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = target.write_text(text)
    (dotfiles / "provision.sh").chmod(0o755)
    git(env, base, "init", "-q", str(dotfiles))

    result = World(base, cog, dotfiles, home, stubs, log, env)
    result.commit(cog)
    result.commit(dotfiles)
    return result


def test_dockerfile_reconfigures_codex_after_installing_the_throwaway_policy() -> None:
    dockerfile = DOCKERFILE.read_text()
    provision = dockerfile.index("./provision.sh")
    guard = dockerfile.index("COPY guest/ /usr/local/lib/cog/")
    run = dockerfile.index("\nRUN sudo /usr/local/lib/cog/throwaway.sh", guard)
    throwaway = dockerfile.index("throwaway.sh", run)
    configure = dockerfile.index("python tools/configure_codex.py", throwaway)
    reset = dockerfile.index("/usr/local/lib/cog/reset-identity.sh", configure)
    agent = dockerfile.index(
        "/usr/local/lib/cog/configure-github-access.sh shields cloudflare", reset
    )
    end = dockerfile.index("\n\n", agent)
    assert provision < guard < run < throwaway < configure < reset < agent < end
    assert (
        'PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"' in dockerfile[throwaway:configure]
    )
    assert "--claude-settings" in dockerfile[throwaway:configure]
    assert dockerfile.count("\nRUN sudo /usr/local/lib/cog/throwaway.sh") == 1


def test_dockerfile_installs_jq_before_the_throwaway_policy() -> None:
    dockerfile = DOCKERFILE.read_text()
    assert dockerfile.index(" jq") < dockerfile.index("throwaway.sh")


def test_dockerfile_copies_the_guest_scripts_root_owned() -> None:
    dockerfile = DOCKERFILE.read_text()
    copies = [line for line in dockerfile.splitlines() if line.startswith("COPY ")]
    assert copies == [
        f"COPY --chown=1000:1000 dotfiles/ {DOTFILES_IN_IMAGE}",
        "COPY guest/ /usr/local/lib/cog/",
        "COPY cloudflare/ /usr/local/lib/cog/cloudflare/",
    ]
    assert "CLOUDFLARE_AGENT" not in dockerfile


def test_only_the_dockerfile_names_the_user() -> None:
    for script in (
        "guest/configure-github-access.sh",
        "cloudflare/guest/entrypoint.sh",
    ):
        assert "shields" not in (REPO / script).read_text()


def test_the_worker_passes_the_instance_id_to_the_guest_instructions() -> None:
    worker = (REPO / "cloudflare/worker.ts").read_text()
    assert (
        'entrypoint: ["/usr/local/lib/cog/cloudflare/entrypoint.sh", instanceId]'
        in worker
    )
    entrypoint = (REPO / "cloudflare/guest/entrypoint.sh").read_text()
    assert 'sudo /usr/local/lib/cog/install-push-instructions.sh "$1"' in entrypoint
    assert "CLOUDFLARE_AGENT" not in (REPO / "cloudflare/wrangler.jsonc").read_text()


def test_the_context_holds_the_three_trees(world: World) -> None:
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode == 0, result.stderr
    assert sorted(path.name for path in dest.iterdir()) == [
        "cloudflare",
        "dotfiles",
        "guest",
    ]
    assert (dest / "dotfiles/provision.sh").is_file()
    assert (dest / "dotfiles/.claude/settings.json").is_file()
    assert os.access(dest / "dotfiles/provision.sh", os.X_OK)
    assert (dest / "dotfiles/.git").is_dir()
    log = subprocess.run(
        ["git", "-C", str(dest / "dotfiles"), "rev-parse", "--verify", "HEAD"],
        env=world.env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert log.returncode != 0
    assert sorted(path.name for path in (dest / "cloudflare").iterdir()) == [
        "entrypoint.sh",
    ]
    assert sorted(path.name for path in (dest / "guest").iterdir()) == sorted(
        path.name for path in (REPO / "guest").iterdir() if path.name != "__pycache__"
    )
    assert os.access(dest / "guest/throwaway.sh", os.X_OK)
    assert os.access(dest / "guest/configure-github-access.sh", os.X_OK)


def test_the_default_dotfiles_checkout_is_under_home(world: World) -> None:
    target = world.home / "src/github.com/shields"
    target.mkdir(parents=True)
    (target / "dotfiles").symlink_to(world.dotfiles)
    dest = world.base / "ctx"
    result = world.run(str(world.cog / "cloudflare/context.sh"), str(dest))
    assert result.returncode == 0, result.stderr
    assert (dest / "dotfiles/provision.sh").is_file()


def test_the_current_directory_never_chooses_the_dotfiles_checkout(
    world: World,
) -> None:
    result = subprocess.run(
        [str(world.cog / "cloudflare/context.sh"), str(world.base / "ctx")],
        cwd=world.dotfiles,
        env=world.env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "does not exist; pass --dotfiles DIR" in result.stderr
    assert not (world.base / "ctx").exists()


def test_a_checkout_from_before_the_split_is_refused(world: World) -> None:
    _ = (world.dotfiles / ".zshenv").write_text("/etc/dotfiles-github-gateway\n")
    world.commit(world.dotfiles)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert ".zshenv in the dotfiles checkout does not name" in result.stderr
    assert not dest.exists()


def test_a_checkout_that_reads_the_earlier_marker_path_is_refused(
    world: World,
) -> None:
    earlier = "/etc/cog-" + "github-gateway"
    _ = (world.dotfiles / ".zshenv").write_text(f"{earlier}\n")
    world.commit(world.dotfiles)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert (
        ".zshenv in the dotfiles checkout does not name /etc/cog-gateway"
        in result.stderr
    )
    assert not dest.exists()


@pytest.mark.parametrize(
    "missing", ["provision.sh", ".claude/settings.json", "tools/configure_codex.py"]
)
def test_an_incomplete_dotfiles_checkout_is_refused(world: World, missing: str) -> None:
    (world.dotfiles / missing).unlink()
    world.commit(world.dotfiles)
    result = world.context(world.base / "ctx")
    assert result.returncode != 0
    assert "is not a dotfiles checkout" in result.stderr


def test_a_dotfiles_subdirectory_is_refused(world: World) -> None:
    result = world.run(
        str(world.cog / "cloudflare/context.sh"),
        str(world.base / "ctx"),
        "--dotfiles",
        str(world.dotfiles / "tools"),
    )
    assert result.returncode != 0
    assert "is not the top level of its git checkout" in result.stderr


def test_the_destination_must_be_new_or_empty_and_outside_both_repositories(
    world: World,
) -> None:
    full = world.base / "full"
    full.mkdir()
    _ = (full / "x").write_text("x")
    for dest in (full, world.cog / "ctx", world.dotfiles / "ctx", world.base):
        result = world.context(dest)
        assert result.returncode != 0, dest
    assert (full / "x").read_text() == "x"
    assert not (world.cog / "ctx").exists()
    assert not (world.dotfiles / "ctx").exists()


def test_a_secret_in_the_dotfiles_tree_stops_the_context(world: World) -> None:
    secret = planted_secret()
    _ = (world.dotfiles / "leak.txt").write_text(f"token = {secret}\n")
    world.commit(world.dotfiles)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert secret not in result.stdout + result.stderr
    assert not dest.exists()


def test_a_secret_in_the_guest_scripts_stops_the_context(world: World) -> None:
    secret = planted_secret()
    _ = (world.cog / "guest/leak.txt").write_text(f"token = {secret}\n")
    world.commit(world.cog)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert secret not in result.stdout + result.stderr
    assert not dest.exists()


@pytest.mark.parametrize(
    "missing",
    [
        "guest/throwaway.sh",
        "guest/reset-identity.sh",
        "guest/github-gateway-credential",
        "guest/configure-github-access.sh",
        "guest/install-push-instructions.sh",
        "cloudflare/guest/entrypoint.sh",
    ],
)
def test_a_missing_guest_script_stops_the_context(world: World, missing: str) -> None:
    (world.cog / missing).unlink()
    world.commit(world.cog)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert "is missing from the assembled context" in result.stderr
    assert not dest.exists()


def test_a_guest_script_that_is_not_executable_stops_the_context(
    world: World,
) -> None:
    (world.cog / "guest/reset-identity.sh").chmod(0o644)
    world.commit(world.cog)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode != 0
    assert "guest/reset-identity.sh is missing" in result.stderr
    assert not dest.exists()


def test_the_guest_trees_are_readable_and_runnable_whatever_the_checkout_modes(
    world: World,
) -> None:
    for tree in (world.cog / "guest", world.cog / "cloudflare/guest"):
        for path in tree.iterdir():
            path.chmod(0o700 if os.access(path, os.X_OK) else 0o600)
    dest = world.base / "ctx"
    result = world.run(
        "/bin/bash",
        "-c",
        'umask 077 && exec "$@"',
        "bash",
        str(world.cog / "cloudflare/context.sh"),
        str(dest),
        "--dotfiles",
        str(world.dotfiles),
    )
    assert result.returncode == 0, result.stderr
    for tree in (dest / "guest", dest / "cloudflare"):
        for path in (tree, *tree.rglob("*")):
            mode = stat.S_IMODE(path.stat().st_mode)
            assert mode in {0o755, 0o644}, f"{path} is {oct(mode)}"
    assert os.access(dest / "guest/throwaway.sh", os.X_OK)
    assert not list(dest.rglob("__pycache__"))


def test_a_gitleaks_allowlist_in_the_dotfiles_tree_applies_to_the_context(
    world: World,
) -> None:
    (world.dotfiles / "tests").mkdir()
    fixture = world.dotfiles / "tests/fixture.txt"
    _ = fixture.write_text(f"token = {planted_secret()}\n")
    _ = (world.dotfiles / ".gitleaks.toml").write_text("""\
[extend]
useDefault = true

[[allowlists]]
paths = ['''tests/fixture\\.txt''']
""")
    world.commit(world.dotfiles)
    dest = world.base / "ctx"
    result = world.context(dest)
    assert result.returncode == 0, result.stderr
    assert (dest / "dotfiles/tests/fixture.txt").is_file()


@pytest.mark.parametrize("failure", ["secret", "marker", "symlink"])
def test_a_failed_run_keeps_a_destination_that_was_there_empty(
    world: World, failure: str
) -> None:
    if failure == "secret":
        _ = (world.dotfiles / "leak.txt").write_text(f"token = {planted_secret()}\n")
        world.commit(world.dotfiles)
    elif failure == "marker":
        _ = (world.dotfiles / ".zshenv").write_text("/etc/dotfiles-github-gateway\n")
        world.commit(world.dotfiles)
    else:
        (world.cog / "guest/link").symlink_to("throwaway.sh")
        world.commit(world.cog)
    dest = world.base / "ctx"
    dest.mkdir()
    dest.chmod(0o700)
    inode = dest.stat().st_ino
    result = world.context(dest)
    assert result.returncode != 0
    assert dest.is_dir()
    assert dest.stat().st_ino == inode
    assert stat.S_IMODE(dest.stat().st_mode) == 0o700
    assert list(dest.iterdir()) == []


def test_deploy_stages_the_context_and_points_wrangler_at_it(world: World) -> None:
    result = world.deploy("--dotfiles", str(world.dotfiles))
    assert result.returncode == 0, result.stderr
    assert (world.log / "has-dotfiles").exists()
    config = world.log / "config.json"
    base = ".containers[0].images.base"
    assert jq(config, f"{base}.build_context").endswith("/context")
    assert jq(config, f"{base}.dockerfile").endswith("/tree/cloudflare/Dockerfile")
    assert jq(config, f"{base}.build_vars | tostring") == '{"MODULES":"dev"}'
    key = ".containers[0].authorized_keys[0]"
    assert jq(config, f"{key}.name") == "owner"
    assert jq(config, f"{key}.public_key") == "ssh-ed25519 AAAAtest owner"
    listing = (world.log / "context-list").read_text().split()
    assert "./guest/configure-github-access.sh" in listing
    assert "./guest/throwaway.sh" in listing
    assert "./cloudflare/Dockerfile" not in listing
    args = (world.log / "bunx-args").read_text().split()
    assert args[:5] == [
        "wrangler",
        "deploy",
        "--config",
        "cloudflare/wrangler.jsonc",
        "--secrets-file",
    ]
    assert "--containers-rollout=none" not in args
    assert (world.log / "secrets-prefix").read_text() == "ADMIN_TOKEN="
    assert (world.log / "secrets-mode").read_text().strip() == "-rw-------"
    assert (world.log / "context-modes").read_text().split() == ["drwxr-xr-x"] * 3
    assert not list((world.base / "tmp").iterdir())


def test_deploy_worker_only_stages_no_dotfiles_tree(world: World) -> None:
    result = world.deploy("--worker-only")
    assert result.returncode == 0, result.stderr
    assert not (world.log / "has-dotfiles").exists()
    args = (world.log / "bunx-args").read_text().split()
    assert "--containers-rollout=none" in args
    assert "using the dotfiles checkout" not in result.stdout + result.stderr


def test_deploy_worker_only_takes_no_dotfiles_option(world: World) -> None:
    result = world.deploy("--worker-only", "--dotfiles", str(world.dotfiles))
    assert result.returncode == 2
    assert not (world.log / "bunx-args").exists()


@pytest.mark.parametrize("tree", ["cog", "dotfiles"])
def test_a_planted_secret_in_either_tree_stops_deploy_before_wrangler(
    world: World, tree: str
) -> None:
    secret = planted_secret()
    repo = world.cog if tree == "cog" else world.dotfiles
    _ = (repo / "leak.txt").write_text(f"token = {secret}\n")
    world.commit(repo)
    result = world.deploy("--dotfiles", str(world.dotfiles))
    assert result.returncode != 0
    assert secret not in result.stdout + result.stderr
    assert not (world.log / "bunx-args").exists()
    assert not (world.log / "bun-args").exists()
