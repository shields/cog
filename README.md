# cog

cog makes throwaway machines where Claude Code and Codex run with no sandbox and
no permission prompts, and keeps what those agents can reach outside the machine
small. A machine is a Debian 13 VM on a Mac (Lima 2.2.1 or later, vz, arm64) or
a Cloudflare container. Its GitHub access goes through a gateway that holds the
GitHub App tokens on the Mac or in a Cloudflare Worker, so the machine itself
never has one.

cog isolates, and does not hide, what the agents can do inside the machine:
the agents run with full access there, and anything with root can undo the
network rules. What remains is limited to state outside it: the deny rules, the
`git_guard.py` hook from dotfiles, the GitHub gateway and the network isolation
described below.

The VM and gateway files come from shields/dotfiles, where they started. A base
VM and the Cloudflare image are built from a dotfiles checkout: cog runs that
checkout's `provision.sh`, then applies the throwaway policy, and `cog new` adds
the GitHub relay and the secrets to each VM.

## Installing

From the cog checkout, run `./install.sh` (or `make install`) as the logged-in
macOS user, without `sudo`. The installer checks for the required tools,
installs the locked Bun dependencies and compiles one executable. It replaces
`~/.local/share/cog/cog` by rename, links `~/bin/cog` to it and loads the
`dev.msrl.cog.gateway` LaunchAgent running `cog gateway serve`. Reinstall the
same way after updating the checkout. Nothing installed points into the
checkout. The executable embeds the Lima template, guest scripts and stager.
It does not load `.env` or `bunfig.toml` at runtime.

The gateway runs under a Seatbelt profile (`gateway/gateway.sb`, installed as
`~/.local/share/cog/gateway.sb`) through `sandbox-exec`. It may read and write
only `~/.local/state/cog` and `~/.config/secrets/cog`, listen only on the
admin socket and on one socket per VM in `~/.local/state/cog/sock`, read its
own executable, `openssl`, the system libraries and
`~/.config/secrets/FIREWORKS_API_KEY`, and connect only to port 443 and the
name resolver. It cannot read the rest of your home directory, run any other
program, or connect to other ports or sockets. It never touches the Lima
directory: the sockets are on the internal disk because the Lima directory may
be on an external volume, where macOS asks for consent to access files on a
removable volume for each newly built gateway, and the gateway waits for the
answer before it can listen. Apple deprecates `sandbox-exec` but it works. The
installer resolves every path in the profile to a real path and creates the
state and secrets directories (mode 700) when they are missing, so the profile
is fixed at install: moving the place the `FIREWORKS_API_KEY` link points to
needs `./install.sh` again. The profile
does not protect the token files from other programs running as you, and it
leaves the Tailscale and Cloudflare credentials that only the CLI reads, which
share the secrets directory, readable and writable by the gateway. Before it
replaces the running gateway, the installer runs the new executable's `help`
under the profile and stops if that fails; that checks the profile and the
executable, not what the gateway does.

Before the installer replaces the running gateway, it keeps the installed
binary, profile and plist as `.previous` files beside them. If the new gateway
does not report ready within 10 seconds, or any step from stopping the previous
agent to that report fails or is interrupted (Ctrl-C while the previous gateway
finishes its requests, for example), the installer unloads the new agent, puts
the kept files back, starts the previous agent, waits for it to report ready,
and exits 1 with one line that says whether the previous gateway is healthy; if
restoring fails, it says what failed and to run `./install.sh --uninstall` and
install again. The installer ignores further interrupts while it restores. A
first install has nothing to restore: it reports the failure and leaves the new
files and agent in place. The rollback restores the program, the profile and
the agent, not the state: a gateway that ran, even briefly, may already have
disabled registrations or reissued its certificates. A run that was killed can
leave `.previous` files, and the next install then refuses to start until
`./install.sh --uninstall` removes them.

A VM made before the sockets moved to `~/.local/state/cog/sock` (its socket was
in its Lima directory) loses gateway access. When the gateway starts it
disables each such registration and writes one line to
`~/Library/Logs/dev.msrl.cog.gateway.err` that names the VM and its ID, says
that an older cog registered it and that its access is disabled. Run
`cog rm NAME` and make the VM again with `cog new`; `cog rm` still deletes it
and cleans up its Tailscale device, and `cog logs ID` still shows its history.

The installer stops the old agent first: the gateway finishes the requests in
flight, such as a streaming model response, and exits as soon as there are
none; launchd kills it after 60 seconds, so the installer waits up to 70
seconds for it to go. Then it waits for `cog gateway health` to report
readiness. If that fails, check
`~/Library/Logs/dev.msrl.cog.gateway.err`; standard output goes to the adjacent
`.out` file. `./install.sh --uninstall` unloads the agent and removes
its plist, binary, profile and link. It keeps logs, `~/.local/state/cog`,
`~/.config/secrets/cog`, `~/.config/cog` and the VMs.

The Mac needs `limactl`, `git`, `tar`, `gitleaks` 8.19 or newer, `jq`, `socat`,
`gh`, `bun` and `openssl` (macOS ships one). Public checkouts work without a
`gh` login. For GitHub App authorization, log in to `gh` on the Mac.
The gateway uses `gh api repos/OWNER/REPO --jq .id` when
`cog new` needs authorization for a private repository, when `cog grant` needs
authorization, and for `cog authorize` and `cog cloud authorize`. The Homebrew
modules in dotfiles (`brew/*.Brewfile` there) install them; cog installs none
itself, because `brew bundle cleanup` in dotfiles' `provision.sh` would remove
it again. Run `make setup` for the dependencies of the tests.

Homebrew has an unrelated formula named `cog`. While `~/bin` comes before
Homebrew's directory on `PATH`, as dotfiles' `.zshrc` arranges, `~/bin/cog`
shadows it and the formula shadows nothing; do not install the formula where
this `PATH` order does not hold.

## Commands

`cog help` lists the VM, gateway and Cloudflare commands.

```
cog base [--dotfiles DIR] [MODULE...]
cog new [NAME] [--repo OWNER/REPO | --no-repo] [--no-claude-token] [--no-codex-auth]
cog grant NAME [OWNER/REPO] [--profile read|cog]
cog pool add NAME | rm NAME | list | status
cog tailscale config CLIENT-ID
cog rm NAME
cog list
```

`cog base` builds the base VM `cog-base` once, and again to refresh it; it takes
tens of minutes. `cog new` makes a VM from a clone of the base, installs the
secrets and the repository, and opens a shell in it. `cog grant` adds a
repository grant to a running VM. `cog pool` keeps the Claude accounts that
every VM uses through the gateway. `cog rm` disables the VM's GitHub access and
deletes it, and refuses the base. `cog list` is `limactl list`. `ssh lima-NAME`
also works, through `~/.lima/*/ssh.config`.

`cog base` takes the dotfiles checkout from `--dotfiles DIR`, or else
`~/src/github.com/shields/dotfiles`; it never infers it from the current
directory. Options must come before the first module. The directory must be the
top level of a git checkout with an executable `provision.sh`,
`.claude/settings.json` and
`tools/configure_codex.py`, and with a commit. It also fails, before any VM is
created or deleted, when the staged copy of a marker reader
listed under "The contract with dotfiles" does not name the markers that cog
writes, which is what a checkout from before the split looks like. It prints
the checkout and commit it uses.

The build copies the checkout's files, including those that are not committed,
with `tools/stage_tree.sh --source DIR`, which makes a new repository with an
index and no commit. It then replaces that repository's `.git` with the one from
a `git clone --no-local` of the checkout, so the checked-out branch (or a
detached HEAD), its commit history and the tags survive, and local changes
appear as unstaged or untracked files after provisioning. The checkout's other
local branches survive only as `origin/` branches, and only if it has an
origin. Gitleaks scans the copied files, the history of every ref (before an
origin is removed) and the copy of `guest/`, and a finding stops the build.
The staged worktree uses modes 0644 and 0755 regardless of the host umask. An
origin of the form `git@github.com:OWNER/REPO` or
`ssh://git@github.com/OWNER/REPO` is rewritten to HTTPS. Any other origin is
kept as it is, but a URL with a user or password (`ssh://git@gitlab.com/...`
too), or any origin with a query, a fragment or control characters, fails the
build; with no origin, the guest has none. The build then:

1. replaces any existing `cog-base` and starts one from the embedded
   `lima/dev.yaml`, which installs Herdr Core (`hc`) in `/usr/local/bin`.
   It refuses the VM if `~/.lima/_config` has added a host mount;
2. copies the dotfiles tree to `~/src/github.com/shields/dotfiles` in the guest;
3. installs `guest/` into `/usr/local/lib/cog` with `sudo tar -x` and the
   options `--no-same-owner --no-same-permissions`, then sets root ownership and
   the modes 755 and 644 (`chmod -R u=rwX,go=rX`), whatever the modes of the
   checkout and the umask of `sudo tar` are. `cog base` fails before it deletes
   the old base when one of the scripts it runs in the guest is missing;
4. runs `./provision.sh MODULE...` there (with no module, the checkout's own
   default);
5. runs `/usr/local/lib/cog/throwaway.sh` with `--claude-settings` naming the
   checkout's `.claude/settings.json`, then the
   checkout's `tools/configure_codex.py` against `~/.codex/config.toml`;
6. empties `/etc/machine-id`, runs `reset-identity.sh` to forget the
   identifiers the agents stored, stops the VM, sets the shell to zsh and
   protects the VM from deletion.

If a build fails, the half-built VM stays for inspection with
`limactl shell cog-base`, and the next `cog base` replaces it.

`cog new` clones the base (an APFS copy-on-write clone, so it needs little
disk), registers the clone with the gateway, upgrades the Claude Code and Codex
casks before any secret is present, installs the gateway CA, relay and
instructions, and prepares the selected checkout. It then installs secrets with
`/usr/local/lib/cog/setup-secrets`, which reads each value from stdin. If
setup fails or is interrupted after a successful clone, `cog` disables its
registration and deletes the VM. If opening the shell fails after setup, the
VM stays ready; reconnect with `limactl shell NAME`.
`COG_CPUS` and `COG_MEMORY` (a whole number of GiB) override the size in
`lima/dev.yaml` (6 CPUs and 16 GiB), and `COG_BASE` replaces the name
`cog-base`.

Tests replace the terminal and the gateway locations with `COG_PROMPT_INPUT`
(a file supplying the first line for a hidden credential prompt) and
`COG_ROOT`. The program honours both outside tests.

## Connect from your phone

1. Apply the `tag:cog` policy in `shields/tailscale-config`. That tailnet
   uses MagicDNS. The SSH rule lets `shields@msrl.com` sign in as `shields`.
2. Create a dedicated cog client on the Tailscale [Trust credentials][console]
   page. Select **Credential → OAuth** and set **Keys → Auth Keys** to
   **Write** (`auth_keys`) so the Mac can issue join keys. Select only
   `tag:cog`.
3. Choose the **Devices → Core** permission and leave all other scopes off.

   - **Read** (`devices:core:read`) lets `cog new` look up the VM's MagicDNS
     name and check that Tailscale reports SSH ready. The client can read the
     whole tailnet's device inventory. If `cog rm` or rollback needs to
     remove an enrolled device, the local VM can be gone while the tailnet
     device remains. Cog keeps cleanup pending and blocks reuse of the VM name.
   - **Write** (`devices:core`) also lets `cog rm` and rollback delete the
     enrolled device. The `tag:cog` selection limits the tags on issued join
     keys. Anyone holding the OAuth secret can use device write access to
     delete devices with other tags. See [Tailscale issue #10702].

4. Select **Generate credential** and keep that page open. On the Mac, run
   `cog tailscale config CLIENT-ID` with the displayed client ID. Paste the
   client secret at the hidden prompt before closing the page. Cog saves it
   in `~/.config/secrets/cog/tailscale-oauth.json` with mode 0600. Creating
   the client manually keeps the secret out of OpenTofu's R2 state.
5. After updating cog, rebuild an older base once with `cog base`. Run
   `cog new demo`. The clone receives a single-use join key valid for ten
   minutes and joins as its own persistent device. Cog prints the login and
   the assigned MagicDNS hostname, including any suffix Tailscale added.
6. Connect the phone to the same tailnet. In Herdr mobile, add the printed
   hostname on port 22 and enter the printed username. Tailscale SSH uses the
   phone's sign-in. The same address works in a phone SSH client.

The Mac must be awake and the VM running for a connection. After a Mac reboot,
log in and run `limactl start NAME`. Cog starts the gateway at login. The VM
keeps its Tailscale identity and address on restart, even after the join key
expires. Tailscale normally removes an [ephemeral node] after 30–60 minutes
offline, so cog uses persistent nodes. With device write access, `cog rm NAME`
removes its device even when the VM is stopped. If cleanup is pending, check
connectivity and the credential's permissions, then repeat `cog rm NAME`.
Cog keeps the cleanup record on the Mac until it succeeds.

Enrollment starts with new Lima clones created after configuration. On a
Mac without the credential, `cog new` creates local VMs as usual. Removing
the credential turns off enrollment. Cleaning up enrolled VMs still requires
a credential. To rotate it, run the configuration command again with a client
for the same tailnet.

[console]: https://console.tailscale.com/admin/settings/trust-credentials
[Tailscale issue #10702]: https://github.com/tailscale/tailscale/issues/10702
[ephemeral node]: https://tailscale.com/docs/features/ephemeral-nodes

## GitHub access

The gateway is a daemon on the Mac, `cog gateway serve`.
It holds the GitHub App access and refresh tokens under
`~/.config/secrets/cog/` and its state and admin socket under
`~/.local/state/cog/`. A Lima guest receives only a public CA certificate and an
immutable VM ID, never a GitHub token. The gateway's own certificate is valid
for a year and is replaced, when the gateway starts or a VM is registered, once
half of that is left; guests trust the CA, so they do not notice. The CA and
the leaf carry key identifiers (a Subject Key Identifier on both, and an
Authority Key Identifier on the leaf), so the set passes strict verification,
which Python 3.13 and later apply by default. A CA that lacks a Subject Key
Identifier is replaced once, with a new key, when the gateway starts or a VM is
registered, and a leaf that lacks either identifier is replaced under its CA. A
CA that openssl cannot read is an error that names the files to remove, never
a reason to replace it. A VM made before that trusts the old CA and fails to
verify the gateway: run `cog rm NAME` and make it again with `cog new`.

A guest's HTTPS requests for `github.com` and `api.github.com` go to a relay on
`127.0.0.1:443` in the guest, which sends them through the per-VM Unix socket
`/tmp/cog-github.sock` (a reverse forward, one per VM) to the Mac, where the
gateway listens on `~/.local/state/cog/sock/github-UUID.sock`. The gateway
chooses the repository's token after checking the current grant and request.
It refreshes tokens on demand; a refresh failure denies the request. The
guest's git credential helper
(`/usr/local/lib/cog/github-gateway-credential`) and `GH_TOKEN` use a fixed
dummy value, `cog`, that the gateway discards.

`cog new NAME --repo OWNER/REPO` starts the VM with read-only GitHub access.
For a public repository, including `shields/cog` and `shields/dotfiles`, it
uses anonymous reads and creates no grant. For a private repository, it
authorizes on the Mac if necessary and grants the VM read-only access. It
clones the repository over HTTPS into `~/src/github.com/OWNER/REPO` and opens
a shell there. For `shields/dotfiles`, it reuses the base checkout, including
local changes. By default, `cog new` infers the repository from the current
checkout's GitHub `origin`. Use `--no-repo` to skip repository selection.

To enable pushes to `cog/VM-ID/*`, run `cog grant NAME OWNER/REPO` on the
Mac. The default profile is `cog`. Use `--profile read` for a read-only grant.
Omit `OWNER/REPO` to use the current checkout's GitHub origin.
`COG_GITHUB_CLIENT_ID`, `COG_GITHUB_WEB_URL` and `COG_GITHUB_API_URL`
configure GitHub App authorization. Cog also uses the API URL to check anonymous
access and the web URL to recognize an origin and build the clone URL. The
gateway always sends a VM's requests to `github.com` and `api.github.com`, so a
token issued by another server would be sent to GitHub. The Cloudflare commands
ignore all three variables. `cog cloud authorize` uses the built-in client ID,
and the Worker uses `GITHUB_CLIENT_ID` from `cloudflare/wrangler.jsonc`.

Public repositories, including those under `github.com/shields`, are readable
without a grant, even in a VM created with `--no-repo`. Git clone/fetch and
repository REST GET/HEAD requests use anonymous access when the repository has
no grant. Repository web pages and downloads always use anonymous access. The
gateway strips guest credentials and cookies, and GitHub denies anonymous reads
of private repositories. Anonymous API reads use GitHub's unauthenticated rate
limits.

Granted repositories use their token for Git and REST reads. The `cog` profile
also permits pushes to the VM's namespace `cog/VM-ID/*`, including force
pushes. The gateway checks every ref update before forwarding a push; deletions
and push options are denied. GraphQL queries still require exactly one granted
repository because GitHub requires authentication. The `/user` identity read
uses a granted repository token. GitHub API writes, PR creation and updates,
cross-repository GraphQL queries, search queries and other unlisted operations
are denied. `gh pr list` with search filters may therefore fail; basic
repository and PR reads work through the supported routes. GitHub's REST
pagination links name the repository by numeric ID; the gateway rewrites them to
`/repos/OWNER/REPO`, so each page is checked like the first. Other requests by
repository ID are denied, including GitHub's redirect from a renamed or
transferred repository's old name, so use its current name. There is no approval
queue.

Lima and Cloudflare share two built-in profiles. `read` grants reads, and `cog`
also grants pushes to `cog/VM-ID/*`. Grants store these capabilities in the
policy. If you set `COG_PROFILES` for Lima, unset it before running `cog grant`
and choose the intended profile on the command line.

Use these commands on the Mac to change a running VM immediately:

```
cog show NAME
cog grant NAME OWNER/REPO --profile read|cog
cog revoke NAME OWNER/REPO
cog edit NAME
cog logs NAME|VM-ID [--follow|--all]
cog authorize OWNER/REPO
```

`edit` opens the full YAML policy in `$VISUAL`, `$EDITOR` or `vi`; it rejects a
stale revision. Adding a repository runs the GitHub authorization on the Mac
before applying the edit. When `cog grant` needs GitHub authorization, it
copies the user code to the Mac clipboard and opens the verification URL in
your browser. Paste the code there to authorize the repository.
The gateway reads grants for every request, so changes take effect without a VM
restart. `cog rm` disables access before deleting the VM. A new VM with the same
display name receives a new ID and no old grants. `cog logs VM-ID` can
inspect a deleted VM's retained history. The gateway also has `cog gateway health` and `cog gateway disable NAME`.
Internally it stores Lima VM names as `lima:NAME` and refuses to register
`lima:cog-base` or the VM that `COG_BASE` names.

The GitHub App uses device flow with expiring user tokens and no private key.
For your own app, grant repository Contents read/write, and Pull requests,
Actions, Checks and Commit statuses read; the gateway denies PR writes even if
an app has broader permissions. The default public client ID is
`Iv23lim5x4MdkNNgv28z`; set `COG_GITHUB_CLIENT_ID` for your own app. The Mac's
`gh` login reads the repository ID; the device flow requests that
`repository_id` to scope the app token, and the gateway verifies that token can
read the intended repository. The device code and URL are printed on the Mac for
you to complete. To replace an expired or revoked authorization, run
`cog authorize OWNER/REPO` on the Mac; policy grants remain in place.
Revoking the app authorization at GitHub invalidates all its tokens. The gateway
keeps the rotating refresh tokens on the Mac and never sends them to a VM.

Every request decision is logged with VM ID, repository, operation, permitted
refs, policy revision, result, upstream status and duration. Headers, bodies and
raw queries are not logged. Policy changes are separately audited with the actor
and old/new revision. Request logs are kept for 30 days and policy events for
one year; requests fail closed if the audit database cannot be written.
`cog logs NAME --follow` streams recent entries, and `--all` prints
the retained history.

When the gateway answers a request with a refusal or a failure before it has
received the whole body, it closes that connection after the answer, so a
client that keeps connections alive opens a new one for its next request. A
request with no body, or whose body the gateway read to the end, keeps its
connection. A request pipelined behind a refused one is not answered; the
client sends it again.

## Other secrets

Every secret that goes to a guest travels over stdin to
`/usr/local/lib/cog/setup-secrets NAME`, in the guest, and never in an argument
list, an environment or a message.

### Claude Code

A VM holds no Claude credential. `cog new` runs `setup-model-gateway claude` in
the guest, which maps `api.anthropic.com` to `127.0.0.1` in `/etc/hosts`, where
the relay answers with the gateway's certificate. It then checks
`https://api.anthropic.com/__cog__/health` from the guest. The VM's
`~/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN`, which dotfiles' `.zshrc` exports
only on Linux in interactive shells, holds the placeholder `cog`; the gateway
replaces `Authorization: Bearer cog` with the token of a pool account and
forwards the request.

`cog new` has the gateway read the pool again and asks it for the pool state
before it clones anything, and fails with what to do when the pool has no
account, is not usable, or the running gateway is too old to answer. Add an
account with `cog pool add NAME`, or pass `--no-claude-token`, which skips the
pool check, the mapping and the placeholder, so that the VM reaches Anthropic
directly and you can run `claude auth login` in it. `cog new` no longer reads or
asks for a token, and leaves `~/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN` on the
Mac alone.

A base built by an older cog lacks `setup-model-gateway`. Run `cog base` again
before `cog new`; `new` fails and deletes the VM when the script is missing or
the probe fails. VMs that exist already keep the token they have and are not
affected.

At the end of setup, when Claude or Fireworks is wired, `cog new` runs the guest
user's interactive zsh and checks that it exports `NODE_EXTRA_CA_CERTS` as the
system bundle (`/etc/ssl/certs/ca-certificates.crt`), which holds the gateway's
CA, and, unless `--no-claude-token`, `CLAUDE_CODE_OAUTH_TOKEN` as the
placeholder `cog`. Only the words `ca`, `token` and `done` leave the guest,
never a value. If it fails, the VM is deleted and its registration disabled,
with a message of the form `NAME's shell is not set up for Claude through the
gateway: PROBLEMS; the base was built from dotfiles that lack this, so update
the dotfiles checkout and run cog base again`.

### The Claude pool

The gateway can hold several Claude accounts, and their tokens stay on the Mac.
Make one token for each account with `claude setup-token`, then add it with
`cog pool add NAME` (NAME is 1 to 32 lowercase letters, digits and hyphens,
starting with a letter or digit). It asks for the token without echo, stores it
in `~/.config/secrets/cog/claude-pool/NAME` (directory 0700, file 0600), and
tells the running gateway to reload the directory. `cog pool rm NAME` removes an
account and reloads. `cog pool list` prints the names, and works without the
gateway. `cog pool status` asks the gateway for each account's hold and, for
each rate-limit window, its utilization and the time that reading lasts until
(UTC, the window's reset when the provider gave one). It fails with the reason
when the pool is configured but unusable.

`add` refuses a name that exists, so run `rm` first to replace a token. When the
gateway cannot be reached, `add` and `rm` exit non-zero and say that the change
is on disk; start the gateway and run `cog pool status`. A gateway from an older
install does not know the pool: run `./install.sh` again. One bad entry makes
the whole pool unusable, so use these commands rather than editing the
directory; `rm` also takes the file name of a stray entry that is not an
account, such as a copied file. The gateway reads the directory when it starts
and when `add`, `rm`, `cog new` or a VM's registration asks it to, so an entry
that you fixed by hand counts after one of those.

Every `cog new` VM uses the pool, and the gateway keeps each VM on one account
until the rate-limit headers show it near its limit. A 401 from the provider
holds that account for ten minutes, and a request that a VM sends can draw one,
so `cog pool status` may show a hold on a working account. A held account gets
no request while another is free, so the hold lasts its ten minutes unless
every account is held and a request then succeeds on it. Use only the
inference-only token that `claude setup-token` makes, because the gateway
forwards any path with it.

`cog pool add` holds SIGHUP, SIGINT and SIGTERM while it writes the entry, so
the token file is either complete (mode 600) with no temporary beside it, or
absent. A signal that arrives meanwhile takes effect afterwards: the command
exits 129, 130 or 143 and prints `cog: interrupted`, without telling the gateway
to reload even though the token is saved. `cog pool list` shows the account. The
gateway reads it at its next reload (`cog new`, a VM's registration, or another
`add` or `rm`), and only then does `cog pool status` list it; `add` again
reports that the account exists. A SIGKILL or a power loss can leave a temporary
named `.NAME.` and 12 hex digits; `add` and `rm` delete such a file once it is
over a minute old.

### The rest

- `~/.config/secrets/FIREWORKS_API_KEY`, the key `cg` uses, stays on the Mac.
  When the file exists, `cog new` wires `api.fireworks.ai` to the gateway in
  the VM (`setup-model-gateway fireworks`), probes it, and writes only the
  placeholder `cog` to the same path in the VM, so `cg` sends `Bearer cog` and
  the gateway replaces it with the key on the Mac. `cog new` never opens or
  asks for the file. It asks the gateway, which reads the file as it does for
  a request, and fails before it makes the VM when the file is not a regular
  file, empty, unreadable, larger than 4096 bytes, or not one word of visible
  ASCII; the message names the file and never quotes the content. The gateway
  can read only the path that `./install.sh` resolved, so when the file or the
  link's target has moved since the install, the message says to run
  `./install.sh` again. A gateway from an older install cannot answer, and
  `cog new` then says to run `./install.sh`. The gateway reads the file for each
  request that carries the placeholder, so replacing the key on the Mac takes
  effect at the next request, with no restart and no sync. While the file is
  missing or unusable, those requests get a 503 (the daemon writes the reason to
  its stderr once for each change, and nothing for a missing file), and the
  Claude pool and GitHub are unaffected. A request with no credential goes
  through as sent. A base built before `setup-model-gateway` knew `fireworks`
  makes `cog new` fail and delete the VM until `cog base` rebuilds the base.
- Codex's login on the Mac, `~/.codex/auth.json` (the file OpenAI documents
  copying to a headless machine), goes to `setup-secrets CODEX_AUTH`, which
  checks that it is a JSON object and writes it to the same path in the VM
  (directory 0700, file 0600). `cog new` fails before it makes the VM when the
  file is missing, not a regular file, unreadable, empty or not a JSON object.
  The file exists only when `cli_auth_credentials_store` in
  `~/.codex/config.toml` is `file`: with `keyring` or `auto` Codex keeps the
  login in the Keychain, and OpenAI says the copy does not apply then. So set
  `cli_auth_credentials_store = "file"` and run `codex login` on the Mac first.
  `--no-codex-auth` skips it, and then says to run `codex login --device-auth`
  in the VM, after you turn on device code login in ChatGPT's security
  settings.

## What is isolated

Isolated, with `lima/dev.yaml` as the source:

- No host directory is mounted. `lima/dev.yaml` sets `mounts: []`, and
  `cog base` fails if `~/.lima/_config` has added any.
- No guest port is forwarded to the Mac. Lima still opens `127.0.0.1` ports on
  the Mac for SSH and for its DNS resolver, which other programs on the Mac can
  reach. The GitHub gateway has one reverse Unix socket forward per VM.
- On enrolled VMs, the Tailscale interface accepts SSH. Guest services on
  other ports and forwarded traffic are dropped. The VM keeps Lima DNS and
  does not accept subnet routes.
- The SSH agent is not forwarded, and the proxy environment is not propagated.
- An nftables filter in the guest rejects connections to the Mac
  (`192.168.5.2`, also `host.lima.internal`, whose other ports reach the Mac's
  loopback), to the private ranges `10.0.0.0/8`, `172.16.0.0/12` and
  `192.168.0.0/16`, to `100.64.0.0/10`, to `169.254.0.0/16` and to `fc00::/7`.
  The VM may use only DNS and DHCP at `192.168.5.2`. The rules load before the
  network comes up on every boot, and Lima rewrites them on every boot.

A VM holds no real Claude credential: its Claude Code sends the placeholder
`cog`, and the gateway adds a pool token on the Mac. While the `/etc/hosts`
mapping is installed, a program in the guest that sends its own Anthropic API
key or login to `api.anthropic.com` is refused with 403, since the gateway
accepts only the placeholder or no credential. The gateway attributes each
request to the VM, and `cog logs NAME` shows it. A VM made with
`--no-claude-token` has no mapping and keeps whatever login it makes.

The same holds for Fireworks when the Mac has a key file: the VM holds only the
placeholder `cog` for `api.fireworks.ai`, the gateway adds the key on the Mac,
and any other credential, or `x-api-key`, sent to that name is refused with 403.

Not isolated:

- The internet. The agents need it, so HTTPS and every other public address
  work, and so does DNS, through Lima's resolver on the Mac.
- Anything with root in the VM. `sudo` needs no password, so a process there can
  delete the filter or the GitHub hosts mapping. These controls stop ordinary
  clients, not a determined attacker.
- Direct connections to GitHub IPs, other GitHub hostnames or a new outbound
  proxy. General internet access is unrestricted, so the gateway cannot force
  every possible GitHub connection through itself. It does keep its app tokens
  off the VM; the policy is a boundary around those tokens, not around arbitrary
  network traffic or credentials acquired by the guest.
- The Codex login in the VM. Agents can read and send it to public addresses.
  The VM has no GitHub App token or refresh token.
- What a Fireworks key on the Mac allows. The gateway forwards any path on
  `api.fireworks.ai` with it, as it does for the Claude token, so anything in an
  enabled VM can do what the key allows without reading it, until
  `cog gateway disable NAME` or removing the key file stops it.
- The Mac's own public address, if it has one. Only the private ranges are
  rejected.

## What the agents may do

`guest/throwaway.sh --claude-settings FILE` makes a machine a throwaway
environment. It
creates `/etc/cog-throwaway`, which dotfiles' `.zshrc` tests (without a fork)
and only on Linux; the Mac and a persistent Linux box have no such file and keep
their sandboxed, prompting behavior.

- Claude Code gets `/etc/claude-code/managed-settings.json`, which no other
  settings file overrides. It starts in `bypassPermissions` mode and disables
  the sandbox. In that mode ask rules and a hook's ask still prompt, so managed
  settings are the only source of permission rules and hooks, and carry the
  `permissions.deny` rules, the `git_guard.py` hook and the status line from the
  settings file given. The ask rules (package installs) and
  `dependency_guard.py` therefore do not apply, and neither do hooks from a
  project's own `.claude/settings.json`. In dotfiles' `c`, the usual
  `--permission-mode=auto` and sandbox settings are left out, because they would
  override managed settings.
- Codex gets `/etc/codex/config.toml` with `approval_policy = "never"` and
  `default_permissions = ":danger-full-access"`, and a rules file that forbids
  `gh api` write methods. `~/.codex/config.toml` overrides any key it sets, so
  the dotfiles checkout's `tools/configure_codex.py` detects
  `/etc/cog-throwaway` and selects the same full-access profile there. The
  network proxy is disabled in both configs. Lima bases and Cloudflare agent
  images run the configuration script after installing the throwaway policy.
  Re-provisioning preserves these settings. `cx` is plain `codex`.
- In a gateway VM, `git_guard.py` and the installed deny rules allow `git push`;
  the gateway checks the destinations against `cog/VM-ID/*`. The hook still
  stops `git commit --no-verify`, and the agent policies still refuse the listed
  `gh` write commands. The hook also refuses `gh api` with a method other than
  GET or HEAD, and with `-f`, `-F` or `--input` unless it names GET or HEAD; a
  GraphQL query is exempt. The deny rules refuse `gh api` write methods as well,
  and Claude Code's matcher also looks inside a quoted `$(...)`, which the hook
  does not. The gateway is the final check for API calls.
- Both backends run `configure-github-access.sh`. It removes the five
  `git push` deny rules from the managed settings and fails if it removes none.
  It deletes `~/.codex/rules/no-push.rules` and writes the Lima VM's UUID or
  `cloudflare` to `/etc/cog-github-gateway`. It sets github.com's credential
  helper with `git config --file ~/.config/git/config --replace-all` because
  chezmoi manages `~/.gitconfig`. With the marker present, dotfiles'
  `provision.sh` configures only gist.github.com's helper.
- On Lima, `setup-github-gateway` also installs the CA, the `/etc/hosts`
  mapping of the GitHub hosts to `127.0.0.1` and the relay unit
  `cog-github-gateway`. `setup-model-gateway` then adds the mappings of
  `api.anthropic.com` (`claude`) and `api.fireworks.ai` (`fireworks`) to the
  same relay. The Cloudflare image does not run it.
- Both backends tell agents their exact `cog/VM-ID/*` namespace and instruct
  them to fetch and rebase onto the updated base branch before every push.
  Lima installs these instructions during gateway setup. The Cloudflare Worker
  passes the VM's UUID to the container entrypoint, which installs them at
  startup. The instructions survive re-provisioning in Claude Code's
  `/etc/claude-code/CLAUDE.md` and Codex's `/etc/codex/requirements.toml`
  (`additional_developer_instructions`). On Cloudflare, dotfiles' `wt`
  refuses to create a worktree because the gateway marker holds `cloudflare`.

## Checks to run once with real credentials

Automated tests use stubs for launchd and Lima and do not deploy to Cloudflare.
They do not verify real launchd startup, VM network isolation, the guest relay,
agent behavior with managed settings, live GitHub authorizations, a Wrangler
deploy or an agent image build. After installing, run `cog base` and
`cog new t1 --repo OWNER/REPO` for a public repository. Then check:

- The installed gateway starts under its Seatbelt profile
  (`launchctl print gui/$UID/dev.msrl.cog.gateway` lists
  `/usr/bin/sandbox-exec` first among its arguments), `cog gateway health`
  passes, a new cog registers, fetches and pushes through it, a certificate is
  reissued (delete `github.pem` and `github-key.pem` in
  `~/.config/secrets/cog` and restart), and a model request is served.
  `~/Library/Logs/dev.msrl.cog.gateway.err` shows no `EPERM` line, and no
  `ECONNREFUSED` for a host that is up, which is how Bun reports a connection
  that the profile denies.
- `zsh -ic exit` prints nothing, `git --version` is 2.54 or later, and
  `git hook list pre-commit` lists gitleaks.
- `stat /usr/local/lib/cog` shows it root-owned and not writable by group or
  other.
- In a fresh repository under `~/src`, `c` opens with no dialogs and shows
  bypass-permissions mode, and `/sandbox` shows that the sandbox is off.
- In the VM, `gh api repos/OWNER/REPO` and `git pull` work, and
  `codex debug prompt-input hi` shows the `cog/VM-ID/`
  instructions. A push to `cog/VM-ID/check` fails. On the Mac, run
  `cog grant t1 OWNER/REPO` and complete authorization if prompted.
  Check that `gh run list` and `gh run view --log` work.
  A push to `cog/VM-ID/check` now succeeds, including a forced update,
  a push of more than 1 MiB and a push from a `--depth 1` clone. A push to
  `main`, a branch deletion, a PR write, and a read of an ungranted private
  repository fail. `cog logs t1` on the Mac records each decision.
- `cog grant t1 OTHER/REPO` adds a grant while the VM runs; revoking it with
  `cog revoke t1 OTHER/REPO` takes effect on the next request.
- Replacing an expiring access token happens on the Mac on demand. After a
  revoked or expired refresh token, `cog authorize OWNER/REPO` restores
  the authorization; the VM never receives it.
- `claude -p hi` answers in a fresh cog without a login, and
  `~/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN` in the VM holds only `cog` (no
  `sk-ant-` string is in the VM's files or environment). `cog logs t1` on the
  Mac shows `model.claude` rows that name the pool account, and
  `cog gateway disable t1` makes `claude -p hi` fail. `codex` runs without a
  login too (with the Mac's `codex login`; `codex login status` says so).
- `emacs -nw` starts and exits.
- `cog new` passes its shell check with the real dotfiles. In the VM, a Python
  program that opens `https://api.anthropic.com/__cog__/health` with
  `ssl.create_default_context()` verifies the gateway's certificate.
- With a Fireworks key on the Mac, `cg -p hi` answers on the Mac and in a fresh
  cog whose `~/.config/secrets/FIREWORKS_API_KEY` holds only `cog`, `/status`
  in `cg` names the Fireworks URL and the drop-in among the setting sources, and
  the status line's cost after a few requests matches the Fireworks dashboard.
  `cog logs NAME` shows `model.fireworks` rows with the reason `fireworks key`,
  and replacing the key file on the Mac makes the next request use the new key.
- From the VM, `curl -m3 host.lima.internal:PORT` fails at once for a server on
  the Mac, and `lsof -nP -iTCP -sTCP:LISTEN` on the Mac shows only Lima's
  `127.0.0.1` ports.

## Cloudflare containers

`cloudflare/deploy.sh [--worker-only] [--dotfiles DIR]` stages this checkout,
scans it for secrets, builds the agent image from a dotfiles checkout chosen the
way `cog base` chooses it, deploys the Worker `cog-agent`, and installs a
randomly generated admin secret kept in
`~/.config/secrets/cog/cloudflare-admin-token`. It adds this Mac's
`~/.ssh/id_ed25519.pub` to the staged Wrangler configuration for SSH access,
and needs `git`, `tar`, `bun`, `jq`, `openssl` and `gitleaks` 8.19 or newer.
Unless it is given `--worker-only`, Wrangler also builds the image, so Docker
must be installed and running.

The image context is assembled by `cloudflare/context.sh DEST [--dotfiles DIR]`
in a temporary directory outside both checkouts: `dotfiles/` (a staged and
scanned copy, a git repository with an index and no commit), `guest/` and
`cloudflare/` (from `cloudflare/guest/`), the last two with their modes set to
755 or 644 and the scripts the image runs checked. `cloudflare/Dockerfile`
copies the dotfiles tree to `/home/shields/src/github.com/shields/dotfiles`,
provisions it (`MODULES`, `dev` by default), copies the guest scripts root-owned
to `/usr/local/lib/cog`, and runs `throwaway.sh`, `configure_codex.py`,
`reset-identity.sh` and `configure-github-access.sh shields cloudflare` in that
order. The Worker starts `/usr/local/lib/cog/cloudflare/entrypoint.sh` with the
VM's UUID. The entrypoint installs Cloudflare's runtime CA and the agent push
instructions. With `--worker-only` no dotfiles tree is staged, the image is
reused without building or rolling out containers, and `--dotfiles` is an error.

`cloudflare/wrangler.jsonc` cannot build the image by itself: its `dockerfile`
and `build_context` name `cloudflare/Dockerfile` and the repository root, which
has no `dotfiles/`, so `wrangler deploy` run on it directly fails at the
Dockerfile's `COPY dotfiles/`. `deploy.sh` replaces both in a staged copy with
the context that `context.sh` assembles.

The Worker URL appears in Wrangler's deployment output. Save it once with
`cog cloud config https://NAME.SUBDOMAIN.workers.dev`, which writes
`~/.config/cog/cloudflare-url`. `cog cloud` can run outside the checkout. It
accepts only a bare HTTPS origin and sends the admin token from its file in the
Authorization header, without following redirects.

```sh
cog cloud authorize OWNER/REPO
cog cloud new NAME
cog cloud grant VM-ID OWNER/REPO [--profile read|cog]
cog cloud start VM-ID
cog cloud show VM-ID
cog cloud logs VM-ID
cog cloud events VM-ID
cog cloud revoke VM-ID OWNER/REPO
cog cloud rm VM-ID
cog cloud list
```

`authorize` starts a separate GitHub App device flow for the cloud authority; it
does not save that authorization on the Mac. A grant uses the built-in `read`
and `cog` profiles and defaults to `cog`. A revision check prevents overwriting
another policy edit. Grants and revocations take effect for the next GitHub
request without restarting the VM. `list` shows registered VM IDs, and `rm`
disables the VM and stops its container.

To find a running container and connect, run Wrangler from the checkout after
`make setup`:

```sh
bunx wrangler containers list --json --config cloudflare/wrangler.jsonc
bunx wrangler containers instances APPLICATION-ID --json --config cloudflare/wrangler.jsonc
bunx wrangler containers ssh CONTAINER-ID --config cloudflare/wrangler.jsonc
```

After connecting, clone a granted repository with Git and log in to the agents
in the disposable VM as needed.

The VM receives only a dummy GitHub credential. Its outbound HTTP and HTTPS
requests pass through the Worker, which checks GitHub operations against the
current VM grants and supplies the repository's short-lived token. The Worker
forwards each request to the URL as it parsed it, so a GitHub request goes to
exactly the URL that was checked. A request to any other host is forwarded as it
arrived when its URL is already canonical; otherwise it is re-serialized from
the parsed URL, which percent-encodes a `'` in a query, folds `%2e%2e`, and
turns a backslash into a slash. A request whose URL does not parse is denied and
logged. The refresh token stays in Durable Object storage. GitHub access logs
record the VM, repository, operation, refs, decision, policy revision, upstream
status, and duration without credentials; policy events record before and after
grants. Access logs are retained for 30 days and policy events for 365 days. The
container's filesystem is disposable. An instance has 1 vCPU, 4 GiB of memory
and 20 GB of disk, to leave workspace room around the installed toolchain, and
its inactivity timeout is six hours.

## The contract with dotfiles

cog needs from a dotfiles checkout:

- a git work tree with an executable `./provision.sh [MODULE...]` that honours
  `DOTFILES_KEEP_BREW_DOWNLOADS` and leaves Homebrew at
  `/home/linuxbrew/.linuxbrew` with `uv`, `gh` and the `claude-code@latest` and
  `codex` casks;
- `.claude/settings.json` with a non-empty `permissions.deny` that includes the
  five `git push` rules the gateway setup removes (`Bash(git push*)`,
  `Bash(git -C * push*)`, `Bash(git -c * push*)`, `Bash(git --git-dir* push*)`
  and `Bash(git --work-tree* push*)`), a `PreToolUse` hook whose command
  contains `git_guard.py`, and optionally `statusLine`;
- `tools/configure_codex.py`, which cog runs again after it writes the
  throwaway marker;
- `~/.codex/rules/no-push.rules`, which cog removes in a gateway guest.

dotfiles reads two marker files that cog writes in the guest:
`/etc/cog-throwaway`, whose presence makes the machine a throwaway VM, and
`/etc/cog-github-gateway`, one line holding the VM's UUID, or `cloudflare`. The
readers are `.zshrc`, `.zshenv`, `.zsh.d/wt.zsh`, `.codex/hooks/git_guard.py`,
`tools/configure_codex.py` and `provision.sh`. Where the second file holds a
UUID, dotfiles' `wt` names a new worktree's branch `cog/UUID/worktree-NAME`,
since the gateway accepts pushes only to `cog/UUID/*`. `cog base` and
`cloudflare/context.sh` refuse a checkout whose readers do not name the markers.
The dotfiles README states the same contract, and `tests/test_cog_contract.py`
there checks it from its side.

Model access in a Lima guest also relies on dotfiles. Where
`/etc/cog-github-gateway` exists, `.zshenv` exports `SSL_CERT_FILE`,
`NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` as the system bundle, which holds
the gateway's CA, so Claude Code trusts the gateway for `api.anthropic.com` and
`api.fireworks.ai`. On Linux, `.zshrc` exports `CLAUDE_CODE_OAUTH_TOKEN` from
`~/.config/secrets/CLAUDE_CODE_OAUTH_TOKEN`, where cog writes the placeholder,
so Claude Code sends `Authorization: Bearer cog` and stays in direct mode. `cg`
sends the content of `~/.config/secrets/FIREWORKS_API_KEY`, the placeholder
again, as the bearer token to `https://api.fireworks.ai/inference` and no other
credential.

`cog new` checks the first two of these at its end (see "Claude Code"), so
`.zshenv` must export `NODE_EXTRA_CA_CERTS` as
`/etc/ssl/certs/ca-certificates.crt` and `.zshrc` must export
`CLAUDE_CODE_OAUTH_TOKEN` from its secrets file. It does not check
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` or `cg`.

## History

The commits before "Move the files to their places in this repository" come
from shields/dotfiles, filtered to the files that moved here. Each shows only
that part of its original change, names the paths as they were in dotfiles, and
refers to dotfiles pull requests as `shields/dotfiles#N`. `git log --follow`
follows a file across the move.

## Development

`make setup lint build test` is what CI runs, after `make ci-tools`. `make
build` checks the TypeScript and compiles `build/cog`. To use that binary
without installing it, run `./build/cog gateway serve` in a separate terminal
before running `./build/cog new`. `make test-zsh` builds its own test executable
and tests it with a real gateway daemon and stub Lima commands. See AGENTS.md
for the layout and the rules for changing the code.
