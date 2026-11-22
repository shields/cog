# AGENTS.md

## Commands

- **Install**: `make install` compiles and installs `cog` and starts its
  LaunchAgent on macOS. `./install.sh --uninstall` keeps state, secrets, config,
  logs and VMs. Test only with a temporary HOME and a stub launchctl.
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

- `cog/main.ts` dispatches the Lima lifecycle and gateway commands through
  `cog/commands/`. `grant` takes a bare VM name and optionally `--profile
read|cog`; the gateway (`gatewayName`) stores `lima:NAME`. The gateway commands
  use `gateway/control.ts` in-process; the daemon runs as `cog gateway serve`.
  `make build` type-checks and compiles `build/cog`. The installer uses Bash
  3.2, so
  no `mapfile`, associative arrays, `${var,,}` or expansion of an empty array
  under `set -u`. The TypeScript lifecycle gives children no standard input
  unless it is meant for them, inherits the environment unchanged, reads
  `HOME` from the environment, and uses fixed secret-validation and spawn
  errors. Only `gateway serve` sets a global umask. `cog/resources.ts` embeds
  `lima/dev.yaml`, `guest/`, `profiles.yaml` and `tools/stage_tree.sh` as text;
  a new file in `guest/` needs an import there, and `cog/embedded.d.ts` declares
  each import's type, since bun-types types `*.yaml` as a parsed object.
  Both native builds disable Bun's dotenv and bunfig autoloaders.
- `cloudflare/deploy.sh`, `cloudflare/context.sh` and `tools/stage_tree.sh` also
  run on the Mac under bash 3.2. `guest/` and `cloudflare/guest/` run in the
  guest (Debian 13) and are installed root-owned in `/usr/local/lib/cog` by
  `cog base` (`sudo tar -x --no-same-owner --no-same-permissions` after
  `gitleaks dir`) or by the image's `COPY`. Nothing of cog goes in the guest's
  `~/bin`. `setup-github-gateway` and `setup-secrets` find their siblings
  through their own directory, but `throwaway.sh`'s timer unit and
  `cloudflare/guest/agent.sh`'s credential helper name `/usr/local/lib/cog`
  itself, so `guest/` cannot move.
- The committed `cloudflare/wrangler.jsonc` is a template: `deploy.sh` rewrites
  its `dockerfile` and `build_context` in a staged copy to the context that
  `context.sh` assembles, and `jq` reads it, so it takes no comments.
- `cog base` reads the dotfiles checkout from `--dotfiles DIR` or
  `~/src/github.com/shields/dotfiles`, never from the current directory.
  `cloudflare/context.sh` checks the same checkout contract independently so
  it can build an image without the macOS installation or gateway.
- `gateway/` holds the policy, state (SQLite), authorization, certificates and
  the HTTPS-over-Unix-socket server. `gateway/control.ts` is what the commands
  that administer it share (locations, health, sync, register and its
  rollback, disable, grant, revoke, the profile parser and the policy
  document); it opens the state and the authorizations on first use, and
  `State` refuses to register `lima:cog-base` and the VM that `COG_BASE`
  names. `cloudflare/` holds the Worker (`worker.ts`), the authority Durable
  Object and the outbound interceptor, which applies `gateway/policy.ts`. The
  container gets no GitHub token. `cog/commands/cloud.ts` administers the Worker
  using the HTTPS origin saved by `cog cloud config` and the admin token file
  written by `cloudflare/deploy.sh`. It refuses redirects and does not depend
  on the checkout. `profiles.yaml` holds the `read` and `cog` templates; the
  persisted grant field that enables pushes is `pushCogBranches`. `cog cloud`
  uses the embedded profiles; `COG_PROFILES` only overrides the Lima profiles.
- Names: the push namespace is `cog/VM-ID/*`; the markers are
  `/etc/cog-throwaway` and `/etc/cog-github-gateway`; the base is `cog-base`
  (`COG_BASE`); the guest socket is `/tmp/cog-github.sock`; the health path is
  `/__cog__/health`; the dummy credential is `cog`. State is
  `~/.local/state/cog` and secrets are `~/.config/secrets/cog`; `COG_ROOT` moves
  them in tests. `install.sh` installs `~/.local/share/cog/cog` by rename and
  links `~/bin/cog` to it. The generated `dev.msrl.cog.gateway` LaunchAgent
  names that executable, not the checkout. The README describes the manual
  migration and the unrelated Homebrew formula named `cog`.
- `guest/throwaway.sh` requires `--claude-settings FILE`, since cog has no
  `.claude/settings.json`; the tests use `tests/fixtures/claude-settings.json`.

## Secrets

No secret may reach an argument list, an environment, a log or a message. The
Claude token, Codex login and Fireworks key go to `guest/setup-secrets NAME` on
stdin, and the CA to `setup-github-gateway`'s stdin. `cog new` upgrades the
agents before it installs any secret. Rollback starts after a successful clone
and ends before opening the interactive shell. A setup failure or signal in
that interval disables the registration and deletes the VM. The staged dotfiles tree, its history and `guest/` are scanned with
gitleaks before anything enters a guest. Every `limactl` call
reads `/dev/null` unless a pipe or file is meant for it, or it is the final
shell, so that none swallows what was typed for the shell; `tests/test_cog.zsh`
holds a line in cog's stdin and checks that only the final shell reads it.
`cog base` never reads cog's stdin, including during staging.

## Contract with dotfiles

dotfiles reads the two markers and the shape of the settings that cog writes,
and cog reads dotfiles' `provision.sh`, `.claude/settings.json`,
`tools/configure_codex.py` and `~/.codex/rules/no-push.rules`. The README's "The
contract with dotfiles" lists them, and dotfiles' README states the same.
Renaming a marker, changing what a marker holds (`cog-github-gateway` is a VM
UUID or `cloudflare`), or changing what `throwaway.sh` and the removal of the
push deny rules (`setup-github-gateway`, `cloudflare/guest/agent.sh`) require of
the settings file (a non-empty `permissions.deny`, a `PreToolUse` hook
containing `git_guard.py`, the five `git push` deny rules, at least one of which
must be present) needs the same change in dotfiles. The marker lists in
`cog/commands/base.ts` and `cloudflare/context.sh` must include every dotfiles
file that reads a marker. The `cog/UUID/*` branch names come from dotfiles' `wt`.

## Tests

- `make test-zsh` compiles a native executable for `tests/test_cog.zsh` with
  both Bun autoload flags disabled. It embeds a test-only stager wrapper to
  inject failures without exposing that control in the shipping binary. The
  suite runs `cog gateway serve` in a per-case `COG_ROOT` under `/tmp` because
  the gateway refuses socket paths over 100 bytes. It issues a common test CA,
  seeds fake authorizations and reads gateway state via `tests/gateway_state.ts`.
  The stubs record argv, environment and stdin in isolated fixture environments.
  Tests cover umasks 000, 022 and 077, signals at the cleanup stages of `new` and
  `base`, and redaction of parse errors. `tests/test_setup_secrets.zsh` uses
  stubs and runs anywhere.
- `tests/test_install.py` gives the installer a temporary home and substitutes
  launchctl, Bun and plutil. `gateway/*.test.ts` and `cloudflare/*.test.ts` cover
  the policy, token refresh, live grants, audit and the HTTPS Unix socket.
  `cog/*.test.ts` cover the CLI and foundation modules; the no-echo prompt
  runs under a pseudo-terminal and needs `stty`. `tests/fake_github.py` and
  `tests/test_github_app_token.py` cover `guest/github_app_token.py`, which no
  `cog` flow uses.
- No automated test covers a live launchd install, real GitHub authorization,
  network isolation and the relay in a VM, agent behavior under the installed
  managed settings, a Wrangler deploy or a build of the agent image.
