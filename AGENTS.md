# AGENTS.md

## Commands

- **Setup**: `make setup` installs the locked Bun and uv dependencies.
- **Checks**: `make lint build test`. `COG_FAIL_ON_SKIP=1` makes any skipped
  pytest test fail the run, so a test that needs a tool needs it added to
  `tools/install_ci_tools.sh`, not a skip. Bun and zsh tests have no skip
  mechanism; keep it that way. The Python tests that need `codex`, `limactl`
  or `jq` fail when it is missing, so a Mac needs all three on `PATH` too. The
  token tool's Python 3.13 check runs through `uv`, which fetches that
  interpreter itself. `make lint` also needs the `gh actions-lock` extension,
  which `make actions-lock-install` installs.
- **Formatting**: `make fmt` runs Prettier, Ruff and shfmt; `make lint` checks
  them. Markdown wraps at 80 columns.
- **CI**: `.github/workflows/ci.yml` runs `make lint build test` on ubuntu-26.04
  after `make ci-tools` (`tools/install_ci_tools.sh`) installs the tools the
  tests need. The script pins Lima with a checksum; bump it by hand.
  `zizmor.yml` audits the workflows.

## Layout

- `bin/cog` is the VM command and `bin/cog-gateway` starts the gateway. Both
  run on the Mac under bash 3.2, so no `mapfile`, associative arrays, `${var,,}`
  or expansion of an empty array under `set -u`. `bin/cog-gateway` runs
  `~/.local/share/cog/main.mjs` with Bun; nothing builds or installs that bundle
  yet (`install.sh` is not written), and `gateway/main.ts` is the same program
  run directly. A TypeScript `cog` that replaces both is planned.
- `cloudflare/deploy.sh`, `cloudflare/context.sh` and `tools/stage_tree.sh` also
  run on the Mac under bash 3.2. `guest/` and `cloudflare/guest/` run in the
  guest (Debian 13) and are installed root-owned in `/usr/local/lib/cog` by
  `cog base` (`sudo tar -x --no-same-owner --no-same-permissions` after
  `gitleaks dir`) or by the image's `COPY`. Nothing of cog goes in the guest's
  `~/bin`. A guest script finds its siblings through its own directory.
- `bin/cog` finds `lima/dev.yaml`, `guest/` and `tools/stage_tree.sh` from its
  own checkout, following symlinks, and reads the dotfiles checkout from
  `--dotfiles DIR` or `~/src/github.com/shields/dotfiles`, never from the
  current directory. `cloudflare/context.sh` repeats those checks, and a test
  compares the two copies, so change both.
- `gateway/` holds the policy, state (SQLite), authorization, certificates and
  the HTTPS-over-Unix-socket server. `cloudflare/` holds the Worker
  (`worker.ts`), the authority Durable Object, the outbound interceptor, which
  applies `gateway/policy.ts`, and `admin.ts`. The container gets no GitHub
  token. `profiles.yaml` holds the `read` and `cog` templates; the persisted
  grant field that enables pushes is still `pushTaskBranches`, so keep the name.
- Names: the push namespace is `cog/VM-ID/*`; the markers are
  `/etc/cog-throwaway` and `/etc/cog-github-gateway`; the base is `cog-base`
  (`COG_BASE`); the guest socket is `/tmp/cog-github.sock`; the health path is
  `/__cog__/health`; the dummy credential is `cog`. State is
  `~/.local/state/cog` and secrets are `~/.config/secrets/cog`; `COG_ROOT` and
  `COG_PROFILES` move them in tests. `Library/LaunchAgents/` still holds the
  plist carried over from dotfiles, which runs `~/bin/vm-access`; it is dead and
  goes when `install.sh` lands.
- `guest/throwaway.sh` requires `--claude-settings FILE`, since cog has no
  `.claude/settings.json`; the tests use `tests/fixtures/claude-settings.json`.

## Secrets

No secret may reach an argument list, an environment, a log or a message. The
Claude token, Codex login and Fireworks key go to `guest/setup-secrets NAME` on
stdin, and the CA to `setup-github-gateway`'s stdin. `cog new` upgrades the
agents before it installs any secret, and any failure or signal after the clone
disables the registration and deletes the VM. The staged dotfiles tree, its
history and `guest/` are scanned with gitleaks before anything enters a guest.
Children get no stdin unless a file is meant for them; only the final shell
inherits the terminal.

## Contract with dotfiles

dotfiles reads the two markers and the shape of the settings that cog writes,
and cog reads dotfiles' `provision.sh`, `.claude/settings.json`,
`tools/configure_codex.py` and `~/.codex/rules/no-push.rules`. The README's "The
contract with dotfiles" lists them, and dotfiles' README states the same.
Renaming a marker, changing what a marker holds (`cog-github-gateway` is a VM
UUID or `cloudflare`), or changing what `throwaway.sh` requires of the settings
file (a non-empty `permissions.deny`, a `PreToolUse` hook containing
`git_guard.py`, the five `git push` deny rules) needs the same change in
dotfiles. `marker_readers` in `bin/cog` and `cloudflare/context.sh` must list
every dotfiles file that reads a marker. The `cog/UUID/*` branch names come from
dotfiles' `wt`.

## Tests

- `tests/test_cog.zsh` and `tests/test_setup_secrets.zsh` use stubs for
  `limactl` and the gateway and run anywhere. `gateway/*.test.ts` and
  `cloudflare/*.test.ts` cover the policy, token refresh, live grants, audit and
  the HTTPS Unix socket. `tests/fake_github.py` and
  `tests/test_github_app_token.py` cover `guest/github_app_token.py`, which no
  `cog` flow uses.
- No automated test covers what only a running VM shows: the network isolation,
  the relay and the agents' behavior under the installed managed settings. Nor
  does one cover a Wrangler deploy or a build of the agent image.
