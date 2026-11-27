# AGENTS.md

## Commands

- **Install**: `make install` compiles and installs `cog` and `gateway.sb` and
  starts its LaunchAgent on macOS; it needs `sandbox-exec`.
  `./install.sh --uninstall` keeps state, secrets, config, logs and VMs. Test
  only with a temporary HOME and stubs for `launchctl`, `sandbox-exec` and
  `plutil`.
  The installer links each installed binary, profile and plist to
  `NAME.previous` before it unloads the agent, and from the moment it runs
  `bootout` (`stopping`, then `swapping` once the label is released) an EXIT
  trap (also reached by HUP, INT and TERM, which it then ignores) rolls back
  through `roll_back`: it unloads, renames the `.previous`
  files back (one that is still the installed file is only removed, since `mv`
  leaves two links to one file in place), bootstraps the old plist and waits for
  `$binary gateway health`, with one message and exit 1. A timeout of the wait
  for the label is a plain `die`, with no rollback. A first install restores
  nothing. Success removes the `.previous` files. A leftover one makes a normal
  install die and `--uninstall` removes it. SIGKILL and SIGQUIT skip the EXIT
  trap and leave the `.build.*` staging directory in the share directory and
  the `.cog.*` one in `~/Library/LaunchAgents`; `--uninstall` removes them
  before its `rmdir` of the share directory, which still fails on any other
  file. State is not rolled back.
  An answer to the staged binary's `gateway health` once the label is released
  is also a plain `die` with no rollback, since `stopping` is cleared first: no
  agent is loaded then, so the answer is from a gateway that launchd did not
  start, such as the hand-run `cog gateway serve` of the README's Development
  section. The new daemon would exit as already running
  (`Control.daemonListening`), and every later probe, the rollback's included,
  would be answered by that gateway and read as ready.
- **Setup**: `make setup` installs the locked Bun and uv dependencies.
- **Checks**: `make lint build test`. `COG_FAIL_ON_SKIP=1` makes any skipped
  pytest test fail the run, so a test that needs a tool needs it added to
  `tools/install_ci_tools.sh`, not a skip. Bun and zsh tests have no skip
  mechanism; keep it that way. The Python tests that need `codex`, `limactl`
  or `jq` fail when it is missing, so a Mac needs all three on `PATH` too.
  `make lint` also needs the `gh actions-lock` extension,
  which `make actions-lock-install` installs.
- **Formatting**: `make fmt` runs Prettier, Ruff and shfmt; `make lint` checks
  them. Markdown wraps at 80 columns.
- **CI**: `.github/workflows/ci.yml` runs `make lint build test` on ubuntu-26.04
  after `make ci-tools` (`tools/install_ci_tools.sh`) installs the tools the
  tests need. The script pins Lima with a checksum; bump it by hand.
  `zizmor.yml` audits the workflows.

## Layout

- `cog/main.ts` dispatches the Lima lifecycle and gateway commands through
  `cog/commands/`. `cog disable NAME` (`cog/commands/lifecycle.ts`) calls
  `Control.disable` and cuts the VM off from the gateway for good; there is no
  enable, and `cog rm NAME` then deletes it. `cog gateway` has only `serve` and
  `health`. `cog ls` is `cog list`. `grant` takes a bare VM name and optionally
  `--profile read|cog`; the gateway (`gatewayName`) stores `lima:NAME`. The
  gateway commands use `gateway/control.ts` in-process; the daemon runs as
  `cog gateway serve`.
  `make build` type-checks and compiles `build/cog`. The installer uses Bash
  3.2, so
  no `mapfile`, associative arrays, `${var,,}` or expansion of an empty array
  under `set -u`. The TypeScript lifecycle gives children no standard input
  unless it is meant for them, inherits the environment unchanged, reads
  `HOME` from the environment, and uses fixed secret-validation and spawn
  errors. Only `gateway serve` sets a global umask. `cog/resources.ts` embeds
  `lima/dev.yaml`, `guest/` and `tools/stage_tree.sh` as text;
  a new file in `guest/` needs an import there, and `cog/embedded.d.ts` declares
  each import's type, since bun-types types `*.yaml` as a parsed object.
  Both native builds disable Bun's dotenv and bunfig autoloaders.
- `cloudflare/deploy.sh`, `cloudflare/context.sh` and `tools/stage_tree.sh` also
  run on the Mac under bash 3.2. `guest/` and `cloudflare/guest/` run in the
  guest (Debian 13) and are installed root-owned in `/usr/local/lib/cog` by
  `cog base` (`sudo tar -x --no-same-owner --no-same-permissions` after
  `gitleaks dir`) or by the image's `COPY`. Nothing of cog goes in the guest's
  `~/bin`. Both backends run `guest/configure-github-access.sh` for the push
  rules, dummy credential helper and gateway marker. Both run
  `guest/install-push-instructions.sh` with the instance UUID to tell Claude
  Code and Codex which branches they can push and to rebase before every push.
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
  rollback, disable, grant, revoke and the policy document). It opens the
  state and the authorizations on first use, and
  `State` refuses to register `lima:cog-base` and the VM that `COG_BASE`
  names. `register(name)` makes `STATE/sock` (mode 700) and registers
  `STATE/sock/github-UUID.sock`; `cog new` refuses a state directory whose path
  contains `{{`, `%`, `$`, `:` or `\`, which Lima or ssh would read as something
  else, and a socket that is not directly in that directory or is not named
  `github-[0-9a-f-]+.sock`, and writes the absolute path as the forward's
  `hostSocket`. `Control.register` raises `RegistrationFailedHere` for a
  failure in the caller's process (the socket path's length, the certificates,
  the socket directory, the database), and `cog new` shows that message, since
  the daemon's log holds nothing about it; a failure of the sync that follows
  is the daemon's, and the error points at its log. Once the check below finds
  no daemon, `cog gateway serve` makes the directory, disables each enabled
  registration whose socket is not directly inside it (through `State.disable`,
  as `cog disable` does) with one stderr line per VM, and removes files
  there named like a socket that no enabled registration owns. Bun unlinks a
  listener's socket file when its server closes, so retiring a VM and `stop()`
  need no removal of their own. Such a VM stays removable: `cog rm` of a VM
  whose registration is already disabled deletes it when the Lima VM still
  forwards to the socket that was registered (`State.retiredSocket`,
  `lima.hasGatewaySocket`), and otherwise answers `VM is not active`.
  `cog gateway serve` first asks `Control.daemonListening`, which connects to
  `STATE/admin.sock` and refuses (`a gateway is already running`) when anything
  accepts, whatever it answers or fails to answer; ENOENT and ECONNREFUSED (a
  killed daemon leaves its file) mean none, and any other error throws rather
  than starts, since a second daemon removes the first one's sockets; a
  leftover file that is not a socket is one such error (ENOTSOCK) and stays
  until it is removed by hand. macOS also answers ECONNREFUSED when a
  listener's queue of waiting connections is full, so a daemon that has
  stopped accepting for long enough to fill it reads as none. It is a check,
  not a lock: a second serve passes it if its check runs before the first has
  bound `admin.sock`, which the daemon does last, after the certificates, the
  database and the listener for each VM (tens of milliseconds, or longer when
  it generates RSA 3072 keys). launchd never starts two. The profile allows
  `network-outbound` to the literal admin socket for this probe; without the
  rule Bun reports the denied connect as ECONNREFUSED, which reads as no
  daemon, so the tests that pin the profile's rules are what guard it.
  `gateway/cert.ts` gives the CA a Subject Key Identifier and the leaf a
  Subject Key Identifier and an Authority Key Identifier, so the set passes
  `openssl verify -x509_strict` (Python 3.13+ verifies strictly by default).
  `validLeaf` requires strict verification and both identifiers, and under the
  lock `ensureCertificates` replaces a CA with no Subject Key Identifier, with a
  new key, and then the leaf. LibreSSL's `-x509_strict` does not check the
  identifiers, so `hasExtension` looks for them in `x509 -text`, and throws,
  naming the files to remove, when openssl cannot read the certificate, so that
  a damaged CA is never mistaken for one with no identifier and replaced; strict
  verification is real only on OpenSSL 3, as in CI. The Seatbelt profile needs
  nothing more, since only `req`, `x509` and `verify` run.
  When `handle()` answers an error (the relay 503, a model-host 403, a pool or
  key 503, a GitHub-route 403, audit unavailable) while the request is not
  `complete` and has a body, `respond` sets `Connection: close` and Bun closes
  the connection after the flush; the body is not drained. Bun sets `complete`
  only after the parser delivers the body, so a refusal before any await closes
  even for a small body. A bodiless request or one read to its end keeps the
  connection, the `PushDenied` path still drains up to 64 MB and answers 200,
  and a pipelined request behind a refused unread one is not answered. Bun
  emits no `drain` on an upstream request once its response has ended, so
  `sendBody` stops waiting for one then: it destroys the upstream request and
  reads and drops the rest of the guest's upload, which keeps that connection
  usable. An upstream that answers in full before the upload ends keeps
  receiving the rest only while its request takes each write without
  backpressure; at the first write that has to wait, the upload is cut off, and
  the audit row still says `completed`.
  The same server answers `api.anthropic.com` and `api.fireworks.ai`, the
  third and fourth names on the leaf, for a guest whose `/etc/hosts` points
  those names at the relay. `guest/setup-github-gateway` maps the two GitHub
  names, and `guest/setup-model-gateway` (run by `cog new` after the GitHub
  health probe) maps `api.anthropic.com` for `claude`, unless
  `--no-claude`, and `api.fireworks.ai` for `fireworks`, when the Mac
  has a Fireworks key file. The Cloudflare image runs neither script.
  `gateway/models.ts` (pure) has no allow or deny list of paths: the relay lends
  the host's credential for any path, which a guest that held a token of its own
  could also use, and a list would break when a provider adds an endpoint. It
  refuses a target that is not origin-form printable ASCII, a duplicate Host,
  ambiguous framing, TRACE, a chunked body on a method that the runtime's client
  sends unframed (GET, HEAD, DELETE, OPTIONS, CONNECT), a `Connection` header
  that names an end-to-end header, `x-api-key` and any `Authorization` other
  than `Bearer cog`. A request with no `Authorization` goes straight to
  Anthropic with the client's headers, less the hop-by-hop ones and `Expect`.
  `Bearer cog` is pooled: the gateway replaces that header's value in place
  with a token. It adds no header except `Content-Length: 0` on a body-less
  request that would otherwise go out chunked, and the runtime's client adds
  `Connection: keep-alive`. The target is sent as written and bodies are
  streamed unparsed. An upload that the upstream stops reading for 60 seconds
  fails, since Bun reports neither that stall nor a guest that leaves during
  it. `gateway/pool.ts` reads `claude-pool/` in the secrets
  directory, one file per account, at start and on `/sync`, which `register`,
  `disable` and `cog new`'s pool check request; a missing or empty directory
  means no pool, one bad entry disables the pool, and either way a `Bearer cog`
  request to the Claude host answers 503. Each VM gets a stable account order
  and stays on an account until the rate-limit headers show it near its limit or
  rejected. A 401 holds the account for ten minutes; a guest picks the path and
  headers of the request that draws one, so a hold only steers VMs, never
  refuses one. A 2xx clears it, but a held account is chosen only when every
  account is held, so otherwise the hold lasts its ten minutes. Each VM has its
  own upstream keep-alive agent for each scheme in use (both model hosts share
  the https one, since Node keys connections by host and port) and none is
  shared between VMs. An agent closes a socket that has been idle for 30
  seconds, since one that the network dropped while the Mac slept would fail the
  next request, which cannot be sent again when it has a body.
  `modelHosts` in `gateway/models.ts` is the table of model hosts (host,
  upstream, audit operation, where `Bearer cog` is resolved), and the server
  dispatches on the `Host` header through it. `api.fireworks.ai` follows the
  same request rules as the Claude host. Its `Bearer cog` becomes
  `Bearer KEY`, where `gateway/key-file.ts` reads KEY from
  `Config.fireworksKeyFile` (`~/.config/secrets/FIREWORKS_API_KEY`, which
  `COG_ROOT` does not move), which `cog gateway serve` passes as
  `fireworksKeyFile`. The file is read for each credentialed request, so
  replacing it takes effect at the next request with no restart or sync. It
  must be a regular file (a link to one is followed) of at most 4096 bytes
  holding one word of visible ASCII once carriage returns and surrounding
  whitespace go. Anything
  else answers 503 with a fixed message, and the reason goes to stderr once per
  change, never for a missing file. A request with no credential goes through
  as sent. Rows are `model.fireworks`, reason `fireworks key` or
  `no credential`. Nothing reads Fireworks responses for rate limits, and any
  path on the host goes out with the key.
  `GET /fireworks-key` on the admin socket (`Control.fireworksKey`) answers
  `{state, reason}` from the same `readKeyFile`: `missing` (no file or none
  configured), `usable`, or `unusable` with the reader's fixed reason, and a
  dangling link is `unusable` (`is not a regular file`) though the request path
  treats it as missing. It never returns key bytes, writes nothing to stderr and
  needs no sync. `cog new` asks it through `fireworksWired`, after the VM-exists
  check and before the pool check, because the profile lets only the daemon read
  the path the installer resolved: `missing` leaves Fireworks unwired, `usable`
  wires it, `unusable` fails before the clone, a reason that starts with
  `cannot be read` says to run `./install.sh` again if the file or link moved,
  and a 404 (an older daemon) says to run `./install.sh`. `adminRequest` rejects
  an answer over its size limit rather than parsing a truncated one.
  `cog/commands/account.ts` holds `cog account`, whose `add`, `rm` and `rename`
  take the provider word `claude` (the only one; any other word is a `CogError`
  that quotes the word only when an account may have that name, so that a token
  typed there is not echoed) and change that directory and ask the daemon to
  reload (`rm` takes any plain file name there, so a stray entry that disables
  the pool can be removed). `rename OLD NEW` never opens the token file: under
  `holdingSignals` it `linkSync`s OLD to NEW, which fails with EEXIST rather
  than replace an entry, and unlinks OLD. The loader accepts the two names in
  between as two accounts with one token, and a reload happens only on request,
  so a crash there leaves both; running `rename` again then says that the two
  are one file (same device and inode, read as bigints) and to `rm` OLD, and a
  failed unlink says the same and is not undone. An unlink that finds OLD gone
  is an error too: another command took it, and NEW holds the token. A signal
  that arrives meanwhile ends the command as it does for `add`: after the work,
  with no reload, and over a failed unlink, whose message is then not shown.
  `list` prints `claude NAME` and `status` prefixes each line with `claude`.
  `GET /pool` on the admin socket
  (`Control.pool`) reports the state and each account's hold and readings, never
  a token, and `list` reads the directory with the loader.
  Bun's HTTP server groups response header lines of one name next to the first
  and respells later ones, so duplicates keep their values and count but not
  their exact order.
  `cloudflare/` holds the Worker (`worker.ts`), the authority Durable Object and
  the outbound interceptor, which applies `gateway/policy.ts`. The container
  gets no GitHub token. `cog/commands/cloud.ts` administers the Worker using the
  HTTPS origin saved by `cog cloud config` and the admin token file written by
  `cloudflare/deploy.sh`. It refuses redirects and does not depend on the
  checkout. `gateway/policy.ts` defines both built-in grant profiles.
  `pushCogBranches` enables pushes in a persisted grant. `cog new` reads public
  repositories anonymously and grants read-only access to a private checkout.
- Names: the push namespace is `cog/VM-ID/*`; the markers are
  `/etc/cog-throwaway` and `/etc/cog-gateway`; the base is `cog-base`
  (`COG_BASE`); the guest socket is `/tmp/cog-github.sock` and the host
  sockets are in `STATE/sock`; the health path is
  `/__cog__/health`; the dummy credential is `cog`. State is
  `~/.local/state/cog` and secrets are `~/.config/secrets/cog`; `COG_ROOT` moves
  them in tests. `install.sh` installs `~/.local/share/cog/cog` by rename and
  links `~/bin/cog` to it. The generated `dev.msrl.cog.gateway` LaunchAgent
  names that executable, not the checkout. The README describes the unrelated
  Homebrew formula named `cog`.
- The LaunchAgent runs `cog gateway serve` through `/usr/bin/sandbox-exec`
  with `-f ~/.local/share/cog/gateway.sb` and one `-D NAME=VALUE` for each
  parameter, with working directory `/` (the profile allows reading it) and
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so that `openssl` is
  `/usr/bin/openssl`, the only other program the profile lets it run. The
  gateway finishes its requests in flight on SIGTERM, and a model response can
  stream for minutes, so the plist sets `ExitTimeOut` to 60 seconds, after which
  launchd kills it, and `install.sh` checks for the label to go up to 700 times,
  pausing 0.1 second after each check, so it gives up at least ten seconds after
  launchd kills the gateway. `cog gateway serve` handles SIGINT and SIGTERM from
  its first line, since the default action during the issue of the certificates
  would leave their lock behind and block every later start. The handler runs
  once the issue ends, so a signal that arrives while it waits for a lock that
  another run holds (up to 120 seconds) is bounded by `ExitTimeOut`.
  `gateway/gateway.sb` takes exactly the parameters BINARY, STATE, SECRETS and
  FIREWORKS_KEY through `(param "NAME")`, and the plist passes the same set. The
  daemon never touches the Lima directory, which may be on an external volume.
  Seatbelt matches resolved paths, so `install.sh` resolves each value at
  install time (the Fireworks key link's final target, or its default name under
  the resolved directory when missing) and creates the missing state and
  secrets directories with mode 700, since the gateway cannot create parents.
  The profile names what the daemon may touch and nothing else. In SECRETS:
  `ca.pem`, `ca-key.pem`, `github.pem`, `github-key.pem` and `ca.srl`; `.lock`
  and `.issue-XXXXXX` with the files in it (`gateway/cert.ts`); the records
  `BASE64URL.json` with `.json.PID.MS.tmp` and `.json.lock`
  (`gateway/auth.ts`); `claude-pool/` read-only. The record pattern also fits
  `tailscale-oauth.json`, which only the CLI uses, so a deny for it follows the
  allow. The directories STATE, `STATE/sock` and SECRETS themselves are allowed
  to be listed and given a mode (`STATE/sock` also to be made), since the
  daemon `chmod`s them and fsyncs them. In STATE: `state.sqlite` with `-wal`,
  `-shm` and `-journal`, `sock/github-<hex and dashes>.sock` and `admin.sock`.
  A new file that the daemon makes in SECRETS or STATE needs a rule in the
  profile and a case in the tests that match the code's names against the
  profile (the tests in `gateway/control.test.ts` whose titles start with
  `the profile`), or it fails in production with EPERM that no Linux CI run
  shows. The CLI is not sandboxed, so a file that only it uses needs no rule,
  and a name that only fits the record pattern needs a deny. Unreadable files
  give EPERM and nothing in the system log (macOS 27 records no sandbox
  denials), so find the rule that a failure needs by removing candidates from a
  copy of the profile and running a scratch daemon under `/usr/bin/sandbox-exec`
  with `COG_ROOT` in a short `/tmp` directory; the Bash tool's own sandbox
  forbids `sandbox-exec`, Unix sockets and process inspection.
  The profile reads links with `(allow file-read-metadata (vnode-type SYMLINK))`
  because the daemon opens `~/.local/state/cog`, `~/.config/secrets/cog` and
  the Fireworks key unresolved, and the kernel reads each link on the way; with
  no such rule a linked HOME, `~/.config`, `~/.local`, the state or secrets
  directory, or the key breaks the daemon. A version 1 profile allows
  some operations under `(deny default)`; the profile denies link and
  clone, NVRAM, IOKit properties and services, Darwin notification posting
  (and the lookup of `com.apple.system.notification_center`, which is what
  stops `notify_post`), `process-info*` except the daemon's own `pidinfo`, and
  `sysctl-read` of `kern.proc*`, which is what stops `KERN_PROCARGS2` and
  `KERN_PROC_ALL` from showing other processes' arguments, environment and
  list. Still allowed are, among others, `file-test-existence`, `file-lock`,
  `mach-bootstrap`, `mach-task-special-port*`, `necp-client-open`,
  `socket-ioctl`, `system-privilege`, `system-mac-syscall`,
  `process-codesigning`, `process-info-codesignature` (which `process-info*`
  does not cover) and the `syscall-*` operations; the profile cannot name
  a remote host, so port 443 anywhere and any DNS name stay open, and it cannot
  hide the daemon's own database, CA key and tokens from the daemon. The
  listeners are allowed only on `STATE/sock/github-<hex and dashes>.sock` and
  `STATE/admin.sock`, outbound connections go to that socket, port 443 and
  the resolver, and those to the Mac's own addresses are denied after the
  allow of port 443. Before it unloads the running agent, `install.sh` runs the
  staged binary's `help` under the staged profile from `/`. A change to the
  profile or to the paths it names needs the matching change in `install.sh` and
  the README.
- `guest/throwaway.sh` requires `--claude-settings FILE`, since cog has no
  `.claude/settings.json`; the tests use `tests/fixtures/claude-settings.json`.

## Secrets

No secret may reach an argument list, an environment, a log or a message. The
Codex login goes to `guest/setup-secrets NAME` on stdin, and so do the
placeholder `cog` for Claude and, when the Mac has a Fireworks key file, for
Fireworks; a Lima guest holds no real Claude token or Fireworks key. The
gateway reads the Fireworks key on the Mac for each credentialed request, and
`cog new` never opens the file and learns its state from the gateway.
The CA goes to `setup-github-gateway`'s stdin. `cog new` needs a usable Claude
pool, checked before the clone, unless `--no-claude`. `cog account add
claude` reads a pool token with the no-echo prompt and creates the file
exclusively with mode 600 by a dot-named temporary and a link, so the loader
never sees a partial entry. `writeAccount` runs that write inside
`holdingSignals`, which records SIGHUP, SIGINT and SIGTERM and removes its
handlers in a `finally`; a signal that arrived ends the command with
`Interrupted(129|130|143)` after the write, over any write error and without the
gateway reload. A failure to unlink the temporary after the link (ENOENT is
none) is not a failed write: the entry is complete, so `writeEntry` says that
the token is saved and names the temporary, and the gateway is not asked to
reload. `add`, `rm` and `rename` call `removeStrayTemporaries`, which
deletes regular files named `.NAME.<12 hex>` over 60 seconds old without reading
them (`rm` skips the name it was given); the loader already skips every dot
name. `rm` and `rename`, like `add`, refuse a pool location that is not a real
directory. `cog new` upgrades the agents before it installs any secret.
Rollback starts after a successful clone and ends before opening the interactive
shell. A setup failure or signal in that interval disables the registration and
deletes the VM. The staged dotfiles tree, its history and `guest/` are scanned
with gitleaks before anything enters a guest. Every `limactl` call
reads `/dev/null` unless a pipe or file is meant for it, or it is the final
shell, so that none swallows what was typed for the shell; `tests/test_cog.zsh`
holds a line in cog's stdin and checks that only the final shell reads it.
`cog base` never reads cog's stdin, including during staging.
`cog new` ends, when Claude or Fireworks is wired, with `sh -c 'exec zsh -i -c
"$1" 2>/dev/null' sh SCRIPT` through `lima.shellOutput`, with stdin from
`/dev/null`. The one-line script starts with a bare `print`, which ends any
partial line that the startup files left on stdout, and then prints only the
words `ca` (`NODE_EXTRA_CA_CERTS` is not exported, or does not name a readable
file that is the same inode as `/etc/ssl/certs/ca-certificates.crt`), `token`
(`CLAUDE_CODE_OAUTH_TOKEN` is not exported, or is not `cog`; this clause is
left out with `--no-claude`) and `done`; no value leaves the guest. A
missing `done` or a failing `limactl` is a `CogError`, which the rollback
handles by disabling and deleting the VM. Only a missing `done` blames the
dotfiles; a failing `limactl` (the connection to the VM dropped, say) says so
with its status, since it shows nothing about them. The `2>/dev/null` belongs on
the `exec`, since zsh's startup noise comes before the script runs.

Tailscale enrollment uses a dedicated Mac OAuth client with `auth_keys` write
access for `tag:cog` join keys and at least `devices:core:read` to verify SSH.
Automatic cleanup requires `devices:core` write access, which permits deleting
devices with other tags (see the README's "Connect from your phone"). Only a
one-use auth key enters a clone, on stdin. The base masks tailscaled. The
gateway database records the auth key ID and stable node ID by instance UUID
so cleanup works after a VM stops or is deleted. The SSH rule lives in
`shields/tailscale-config`.

## Contract with dotfiles

dotfiles reads the two markers and the shape of the settings that cog writes,
and cog reads dotfiles' `provision.sh`, `.claude/settings.json`,
`tools/configure_codex.py` and `~/.codex/rules/no-push.rules`. The README's "The
contract with dotfiles" lists them, and dotfiles' README states the same.
Model access in a Lima guest also relies on dotfiles' `.zshenv` (the CA bundle
variables where the gateway marker exists), `.zshrc` (the export of
`CLAUDE_CODE_OAUTH_TOKEN` from its secrets file) and `cg` (the bearer token
from `FIREWORKS_API_KEY`), so a change to where cog writes the placeholder
needs the same change there. `cog new`'s shell check reads two of them: the
`.zshenv` must export `NODE_EXTRA_CA_CERTS` as
`/etc/ssl/certs/ca-certificates.crt` and the `.zshrc` must export
`CLAUDE_CODE_OAUTH_TOKEN` as the placeholder `cog`, so a change to either
needs the same change in `cog/commands/new.ts`.
Renaming a marker, changing what a marker holds (`cog-gateway` is a VM
UUID or `cloudflare`), or changing what `throwaway.sh` and
`configure-github-access.sh` require of the settings file (a non-empty
`permissions.deny`, a `PreToolUse` hook
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
  `base`, redaction of parse errors, and the daemon's disabling of a
  registration outside `STATE/sock` with `cog rm` still deleting that VM. The
  limactl stub answers the guest shell check with `LIMA_STUB_GUEST_CHECK`;
  the cases cover its success, each missing export, empty output and a failing
  call, with rollback and no secret in any output. In each Fireworks case the
  daemon, not a stub, looks for the key file under that case's `HOME` and
  answers `cog new`'s question about its state.
  `tests/test_setup_secrets.zsh` runs in temporary guest homes.
- `tests/test_install.py` gives the installer a temporary home and substitutes
  launchctl, Bun, plutil and sandbox-exec. The sandbox-exec stub checks the
  working directory, the profile's content and the parameters, and the
  launchctl stub's `bootstrap` checks that the profile and executable that the
  plist names are in place. The tests cover the plist, the profile's
  installation and its parameter set, link resolution (the Fireworks key, the
  parents of the share, state and secrets directories, and HOME), refusal of
  control characters and link loops, directory modes, a slow unload, a failing
  validation and uninstall. Its rollback cases make one build unhealthy (the
  `health` stub fails when `unhealthy-BUILD` exists, BUILD being the label the
  `bun build` stub read from a `build` file), make `bootstrap` or `bootout`
  fail once or signal the installer during `bootout`, and check the restored
  files byte for byte, a first install, an unhealthy
  predecessor, a leftover `.previous` and an install killed with SIGKILL,
  which `--uninstall` must clean up; no test sends SIGQUIT, which ends the
  Mac's bash 3.2 but which CI's bash 5 ignores. The stub scripts run
  under `/bin/bash` 3.2 on a Mac, where `set -e` ignores a failing `[[ ]]`, so
  each guard ends in `|| exit 1`.
  The `health` stub also answers with no agent loaded while a `stray` file
  exists, as a gateway that launchd did not start does, and a first install and
  a reinstall must then stop at the first probe, before `bootstrap`, with
  nothing replaced.
  It also reads the profile's text, since CI cannot run it: it starts from
  `(deny default)` and `system.sb`, a list pins every allow, no rule grants all
  of STATE or SECRETS, the deny for `tailscale-oauth.json` follows the
  authorization-record allow, `claude-pool` is read-only, and the process,
  NVRAM, IOKit, notification and local-address denies are present and ordered.
- `cog/logs.test.ts` drives `cog logs --follow` through the `pause` and `emit`
  options of `logs()`. A row printed before it finished (no `duration_ms`) is
  printed again once it has, found each tick by one `json_each` statement
  (`State.logsById`) even when newer rows pushed it out of the 100-row window;
  one that never finishes costs its id in memory and a place in that statement.
- `gateway/*.test.ts` and `cloudflare/*.test.ts` cover the policy, token
  refresh, live grants, audit and the HTTPS Unix socket. `cog/*.test.ts` cover
  the CLI and foundation modules, including a real `gateway serve` that
  disables older registrations, clears stale sockets and removes its own, one
  that is signalled while it issues the certificates, and
  `cog/account.test.ts` signals `cog account add` and `rename` through a hook in
  the write; the no-echo prompt runs under a pseudo-terminal and needs `stty`.
- `gateway/cert.test.ts` checks strict verification and the identifiers on
  both OpenSSL 3 and LibreSSL; a real TLS handshake from Python is not tested.
  `gateway/server.test.ts` counts connections per keep-alive agent, one host
  for each, since Bun's `https.Agent` keys sockets by servername.
- No automated test runs the real profile, which needs macOS.
- No automated test covers a live launchd install, real GitHub authorization,
  network isolation and the relay in a VM, live Tailscale enrollment or a
  Herdr phone connection, agent behavior under the installed
  managed settings, a Wrangler deploy or a build of the agent image.
