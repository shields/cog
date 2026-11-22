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
  run directly. A TypeScript `cog` that replaces both is being written in
  `cog/`; `bin/` does not call it yet. `cog/main.ts` dispatches `show`, `edit`,
  `revoke`, `logs`, `authorize` and `gateway serve|health|disable` through
  `cog/commands/` on `gateway/control.ts`; VMs are bare `NAME` there and
  `lima:NAME` in the gateway (`gatewayName`), and the other verbs say they are
  not implemented. Only `gateway serve` sets a umask. Its modules never use a
  host shell,
  give a child no standard input unless it is meant for it, inherit the
  environment unchanged, read `HOME` from the environment, set no umask, write
  every file with an explicit mode, and use fixed error texts that never quote
  a file or a parse error. `cog/resources.ts` embeds `lima/dev.yaml`, `guest/`,
  `profiles.yaml` and `tools/stage_tree.sh` as text; a new file in `guest/`
  needs an import there, and `cog/embedded.d.ts` declares each import's type,
  since bun-types types `*.yaml` as a parsed object.
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
- `bin/cog` finds `lima/dev.yaml`, `guest/` and `tools/stage_tree.sh` from its
  own checkout, following symlinks, and reads the dotfiles checkout from
  `--dotfiles DIR` or `~/src/github.com/shields/dotfiles`, never from the
  current directory. `cloudflare/context.sh` repeats the dotfiles checkout
  checks and the marker list, and a test compares those copies, so change both.
- `gateway/` holds the policy, state (SQLite), authorization, certificates and
  the HTTPS-over-Unix-socket server. `gateway/control.ts` is what the commands
  that administer it share (locations, health, sync, register and its
  rollback, disable, grant, revoke, the profile parser and the policy
  document); it opens the state and the authorizations on first use, and
  `State` refuses to register `lima:cog-base` and the VM that `COG_BASE`
  names. `cloudflare/` holds the Worker
  (`worker.ts`), the authority Durable Object, the outbound interceptor, which
  applies `gateway/policy.ts`, and `admin.ts`. The container gets no GitHub
  token. `profiles.yaml` holds the `read` and `cog` templates; the persisted
  grant field that enables pushes is `pushCogBranches`.
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
agents before it installs any secret, and any failure, or hangup, interrupt,
quit or terminate signal, after the clone disables the registration and deletes
the VM. The staged dotfiles tree, its history and `guest/` are scanned with
gitleaks before anything enters a guest. Every `limactl` and `cog-gateway` call
reads `/dev/null` unless a pipe or file is meant for it, or it is the final
shell, so that none swallows what was typed for the shell; `tests/test_cog.zsh`
holds a line in cog's stdin and checks that only the final shell reads it. `git`,
`gitleaks` and `tools/stage_tree.sh` inherit the terminal and have no use for
it, and no test checks that they leave it alone.

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
must be present) needs the same change in dotfiles. `marker_readers` in
`bin/cog` and `cloudflare/context.sh` must list every dotfiles file that reads a
marker. The `cog/UUID/*` branch names come from dotfiles' `wt`.

## Tests

- `tests/test_cog.zsh` stubs `limactl`, `gh`, `curl`, `git`, `gitleaks` and
  `tools/stage_tree.sh`, and runs a real gateway daemon (`gateway/main.ts` under
  Bun, since `bin/cog-gateway` needs an installed bundle and Bun at a fixed
  path) in a per-case `COG_ROOT` under `/tmp`, short because the gateway refuses
  a socket path over 100 bytes. It copies the certificates issued once per run,
  seeds fake GitHub authorizations and reads the gateway's instances, grants and
  events through `tests/gateway_state.ts`. `COG_IMPL` (default `bash`) names the
  program under test, and the suite chooses how to launch it in one place. It
  covers the modes of everything cog writes under umasks 000, 022 and 077, a
  hangup, interrupt or terminate signal at each cleanup stage of `new` and `base`,
  and files whose contents a parse error could quote.
  `tests/test_setup_secrets.zsh` uses stubs and runs anywhere.
  `gateway/*.test.ts` and `cloudflare/*.test.ts` cover the policy, token
  refresh, live grants, audit and the HTTPS Unix socket. `cog/*.test.ts` cover
  the foundation modules (the no-echo prompt runs under a pseudo-terminal and
  needs `stty`), and `cog/cli.test.ts` runs `cog/main.ts` against a real daemon
  built into a bundle; `gateway/main.ts` has no test of its own besides the zsh
  suite. `tests/fake_github.py`
  and `tests/test_github_app_token.py` cover `guest/github_app_token.py`, which
  no `cog` flow uses.
- No automated test covers what only a running VM shows: the network isolation,
  the relay and the agents' behavior under the installed managed settings. Nor
  does one cover a Wrangler deploy or a build of the agent image.
