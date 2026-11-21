# AGENTS.md

## Commands

- **Setup**: `make setup` installs the locked Bun and uv dependencies.
- **Checks**: `make lint build test`. `COG_FAIL_ON_SKIP=1` makes any skipped
  pytest test fail the run, so a test that needs a tool needs it added to
  `tools/install_ci_tools.sh`, not a skip. Bun and zsh tests have no skip
  mechanism; keep it that way. The Python tests that need `codex`, `limactl`,
  `jq` or `python3.13` fail when it is missing, so a Mac needs all four on
  `PATH` too (`brew install python@3.13` provides the last). `make lint` also
  needs the `gh actions-lock` extension, which `make actions-lock-install`
  installs.
- **Formatting**: `make fmt` runs Prettier, Ruff and shfmt; `make lint` checks
  them.
- **CI**: `.github/workflows/ci.yml` runs `make lint build test` on ubuntu-26.04
  after `make ci-tools` (`tools/install_ci_tools.sh`) installs the tools the
  tests need. The script pins Lima with a checksum; bump it by hand.
  `zizmor.yml` audits the workflows.
