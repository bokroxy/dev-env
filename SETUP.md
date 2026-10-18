# Setup (for the agent doing the replication)

This file is written for you, the agent, working for a user who wants this pi setup on their machine. The repo root is the pi agent directory. There is no install script: you run the steps below with the user's own tools and ask the user the questions marked **ASK**. Ask them one at a time, and do not guess an answer.

Everything here must work on Linux, macOS and Windows. Use the user's shell and package manager. Shell snippets are given for POSIX shells; on Windows use PowerShell and `%USERPROFILE%` / `$env:USERPROFILE` for `~`.

## 0. Look before you touch

1. Check what already exists: pi installed (`pi --version`), and whether the pi agent directory already has content. It is `~/.pi/agent`, or the directory in `PI_CODING_AGENT_DIR` if that is set.
2. **ASK** the user to confirm the target agent directory.
3. If that directory is empty or missing, clone straight into it (step 2). If it already has files (settings, sessions, `auth.json`, extensions), **do not clone over it and do not overwrite anything**. Clone into a scratch directory, then copy file by file as described in step 2 and show the user every conflict (`settings.json`, `AGENTS.md`, `mcp-adapter.json`).

## 1. Prerequisites

| Need | Why | Tested with |
|---|---|---|
| Node.js with native TypeScript type stripping (23.6 or newer) and npm | pi, the extensions and the MCP servers | 26.10.0 / npm 11.19.1 |
| git | clone | 2.55 |
| pi | the agent itself | 1.3.0 |
| `rg` and `fd` | the `file-search` extension uses them; its fallback downloads a release binary on macOS and Linux only | rg 15.0.0, fd 10.4.2 |
| `eza`, `bat`, `fzf` | named in `AGENTS.md` as the default shell tools | eza 0.23.5, bat 0.26.1, fzf 0.74.4 |
| `gh` | GitHub CLI | 2.97.0 |
| `uv` | Python tooling | 0.11.21 |
| Go | only if the user writes Go | 1.27.2 |

Install pi if it is missing: `npm install -g @earendil-works/pi-coding-agent` (see https://pi.dev). Use the same minor version as above unless the user wants newer.

Install the tools with the package manager already on the machine. **ASK** before installing anything. Names differ per platform:

| Tool | Debian/Ubuntu `apt` | Fedora `dnf` | Arch `pacman` | macOS `brew` | Windows `winget` / `scoop` |
|---|---|---|---|---|---|
| Node.js | use `nvm` or NodeSource | `nodejs` or `nvm` | `nodejs` | `node` | `OpenJS.NodeJS` / `nodejs` |
| ripgrep | `ripgrep` | `ripgrep` | `ripgrep` | `ripgrep` | `BurntSushi.ripgrep.MSVC` / `ripgrep` |
| fd | `fd-find` (binary `fdfind`) | `fd-find` | `fd` | `fd` | `sharkdp.fd` / `fd` |
| eza | `eza` (24.04 and newer) | `eza` | `eza` | `eza` | `eza-community.eza` / `eza` |
| bat | `bat` (binary `batcat`) | `bat` | `bat` | `bat` | `sharkdp.bat` / `bat` |
| fzf | `fzf` | `fzf` | `fzf` | `fzf` | `junegunn.fzf` / `fzf` |
| gh | `gh` | `gh` | `github-cli` | `gh` | `GitHub.cli` / `gh` |
| uv | official installer or `pipx install uv` | `uv` | `uv` | `uv` | `astral-sh.uv` / `uv` |
| Go | official download from https://go.dev/dl/ | official download (the distro package lags) | `go` | `go` | `GoLang.Go` / `go` |

These package names were not all verified on every platform. If one fails, search with the manager (`apt search`, `dnf search`, `brew search`, `winget search`, `scoop search`) and tell the user what you picked. `file-search` finds `fdfind` itself; `AGENTS.md` expects plain `fd` and `bat`, so on Debian-based systems offer to add `fd` and `bat` shims or symlinks to `fdfind` and `batcat` in a directory on `PATH`. Do not use `curl | sh` installers unless the user asks.

## 2. Install the repo

Fresh agent directory:

```sh
git clone https://github.com/bokroxy/dev-env ~/.pi/agent
cd ~/.pi/agent
npm install --ignore-scripts
```

Use `--ignore-scripts`: it skips development-only `prepare` hooks (they patch TypeScript for type-checking, which the user does not need to run pi).

Existing agent directory: clone to a scratch directory, run `npm install --ignore-scripts` in the clone only to confirm it resolves, then copy these into the agent directory without overwriting: `extensions/`, `agents/`, `themes/`, `skills/ultracave/`, `package.json`, `package-lock.json`, `tsconfig.json`, `mcp-adapter.json`, `.env.example`. For `settings.json`, merge by hand: add the `packages`, `subagents`, `defaultTools`, `theme` and `compaction` entries and keep the user's existing keys. For `AGENTS.md`, show the user a diff and let them choose; do not replace their file silently. Run `npm install --ignore-scripts` in the agent directory afterwards.

The first time pi starts, it installs the packages pinned in `settings.json` (`pi-mcp-adapter`, `pi-subagents`, `pi-lens`, `pi-ask`, `remote-pi`, `@caveman-ai/middleware`, `@gotgenes/pi-anthropic-auth`, `@juicesharp/rpiv-todo`) into `npm/`. This takes a minute and needs network access.

## 3. Credentials

Never write a key into a tracked file. `auth.json`, `.env` and `models.json` are git-ignored.

1. **Model access:** tell the user to run `pi`, then `/login` (or set the provider's API key variable). Nothing in this repo sets a provider or model.
2. **Brave Search** (`search` tool): **ASK** whether the user has a Brave Search API key. If yes, `cp .env.example .env` in the agent directory and put the key in `BRAVE_API_KEY=`. If no, delete `extensions/brave-search/`; the rest works without it.
3. **Firecrawl** (`firecrawl_scrape`): see the next section.

## 4. Firecrawl: self-hosted or cloud (ASK)

`mcp-adapter.json` starts `firecrawl-mcp` with `FIRECRAWL_API_KEY` taken from the environment. **ASK the user which they want, and say what each costs:**

- **Cloud (https://firecrawl.dev):** no local resources, but it costs money per use. The user creates an API key and exports it as `FIRECRAWL_API_KEY` in their shell profile (POSIX) or with `setx FIRECRAWL_API_KEY <key>` (Windows; then restart the terminal). pi does not read `.env` for MCP servers, so a real environment variable is required.
- **Self-hosted:** free per call, but it runs a Docker Compose stack (API, Playwright, Redis, RabbitMQ, PostgreSQL) on the user's machine and uses real CPU, RAM and disk. The user must have Docker (or a compatible runtime) and must be willing to maintain it. Follow https://docs.firecrawl.dev/contributing/self-host and https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md: check out an exact release tag, keep `USE_DB_AUTHENTICATION=false` for a first run, and keep the API bound to `127.0.0.1` (it is unauthenticated). The API listens on port 3002. Then, in `mcp-adapter.json`, add `"FIRECRAWL_API_URL": "http://127.0.0.1:3002"` to the `firecrawl` server's `env` block and export `FIRECRAWL_API_KEY` as any non-empty placeholder.
- **Neither:** remove the `firecrawl` entry from `mcp-adapter.json`. Tell the user that `AGENTS.md` and the `researcher` and `evidence-auditor` agents refer to `firecrawl_scrape`, and that research quality drops without it.

Do not commit the self-host URL into the shared repo file; it is a local edit.

## 5. Optional pieces (ASK for each)

- **Clef** (`extensions/clef`, `agents/clef.md`): Cloudflare Clef decision models. It needs a Cloudflare Workers AI credential (`/login` to Cloudflare Workers AI, or `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`). The `clef` subagent runs the command `clef`; put a launcher named `clef` on `PATH` that runs `node <agent dir>/extensions/clef/cli.ts "$@"` (a one-line `sh` script on POSIX, a `clef.cmd` on Windows). If the user does not want Clef, delete both paths.
- **GitNexus** (`gitnexus` MCP server): it is started with `npx -y gitnexus@1.6.12 mcp` and needs no global install. It is licensed PolyForm Noncommercial: tell the user, and remove the entry if their use is commercial. To index a repository the user must run `npx gitnexus@1.6.12 analyze --index-only` in it. Do not run plain `gitnexus analyze`; it rewrites `AGENTS.md` and `CLAUDE.md`. Semantic (embedding) search is not part of this setup.
- **`remote-pi`:** mobile remote control; remove it from `settings.json` if the user does not want it.
- **Clipboard:** `/copy-all` needs a clipboard tool on Linux (`wl-copy`, `xclip` or `xsel`).

Removing an extension means deleting its directory under `extensions/`; nothing else references it, except `todo-presentation`, which needs the `@juicesharp/rpiv-todo` package, and `agent-view`, `clef` and `workflows`, which share `extensions/shared/`.

## 6. Platform notes

- **Linux:** the tested platform.
- **macOS:** `workflows` identifies its worker process with `ps` instead of `/proc`. Not tested.
- **Windows (native):** `workflows` uses a named pipe for control and PowerShell (`Get-CimInstance`) for process identity. `file-search` cannot download `fd` and `rg` on Windows; install them with `winget` or `scoop`. `background-terminals` runs commands through `cmd.exe`. Not tested.
- Report anything that breaks on macOS or Windows to the user as a finding. Do not claim it works.

## 7. Verify, then report

1. `pi --version`, then start `pi`. The startup listing shows `[Skills]`, `[Prompts]` and `[Extensions]` as one line each, and no `[Extension issues]` line. Press Ctrl+O to expand the sections and read any issue.
2. `pi list` shows the eight packages with install paths.
3. Run `/context-bar`, `/ps` and `/workflows` once each; they open without an error.
4. After the key is set, ask the model to scrape one page with `firecrawl_scrape` and one search with `search`.
5. Report to the user what you installed, what you skipped or removed, and anything you could not verify.

## What this setup does not include

Skills other than `ultracave`, a GitNexus embedding server, the `rea` and `docs` MCP servers, and any credentials or model selection. If the user wants one of these, treat it as a separate task.
