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

.PHONY: setup ci-tools build install test test-bun test-zsh test-python lint lint-ts lint-python lint-shell fmt fmt-check

PRETTIER_SOURCES = .

# Shell scripts to lint and format with shellcheck and shfmt. zsh files
# (tests/*.zsh) are excluded because neither tool supports zsh.
SHELL_SOURCES = \
	install.sh \
	cloudflare/context.sh \
	cloudflare/deploy.sh \
	cloudflare/guest/agent.sh \
	cloudflare/guest/entrypoint.sh \
	guest/github-gateway-credential \
	guest/reset-identity.sh \
	guest/setup-github-gateway \
	guest/setup-secrets \
	guest/throwaway.sh \
	tools/install_ci_tools.sh \
	tools/stage_tree.sh

build:
	bun run tsc --noEmit
	bun run tsc --noEmit -p cloudflare/tsconfig.json
	bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig cog/main.ts --outfile build/cog

install:
	./install.sh

setup:
	bun install --frozen-lockfile
	uv sync --locked

ci-tools:
	tools/install_ci_tools.sh

test: test-bun test-zsh test-python

test-bun:
	bun test cog/*.test.ts gateway/*.test.ts cloudflare/*.test.ts

test-zsh:
	zsh tests/test_cog.zsh
	zsh tests/test_setup_secrets.zsh

test-python:
	uv run pytest

lint: actions-lock-verify-local fmt-check lint-ts lint-python lint-shell

lint-ts:
	bun run eslint .

lint-python:
	uv run ruff check
	uv run ty check
	basedpyright

lint-shell:
	shellcheck --exclude=SC1091 $(SHELL_SOURCES)

fmt-check:
	bun run prettier --check $(PRETTIER_SOURCES)
	uv run ruff format --check
	shfmt -i 4 -d $(SHELL_SOURCES)

fmt:
	bun run prettier --write $(PRETTIER_SOURCES)
	uv run ruff format
	shfmt -i 4 -w $(SHELL_SOURCES)

.PHONY: actions-lock-install actions-lock actions-lock-verify-local actions-lock-verify

actions-lock-install:
	gh extension install github/gh-actions-lock --pin v0.5.1 --force

actions-lock:
	gh actions-lock --no-interactive

actions-lock-verify-local:
	gh actions-lock --verify-local

actions-lock-verify:
	gh actions-lock --verify
