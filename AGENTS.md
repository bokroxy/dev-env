When working in typescript:

- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when you're done making a change. if they don't exist, suggest making them for the project you're in
- avoid explicit return types unless absolutely needed
- `as any` should be an absolute last resort. always use real type safety. lean on type inference instead of manually writing new types over and over again

When working in svelte(kit):

- use modern svelte practices; if a svelte best-practices skill is available, reference it when writing .svelte file code

In general:

- when asking questions, ask them one at a time

## Research and web sources

- When uncertain about any fact, version, benchmark, changelog, or current state of a project, **scrape the primary source with `firecrawl_scrape`** instead of guessing or relying on search snippets.
- Search results (`search`) are for discovery only. Before citing or concluding, open and read the relevant pages (official docs, wikis, changelogs, release notes, benchmark articles, forum threads).
- Prefer primary sources (project docs/wikis, GitHub repos/issues, benchmark write-ups) over SEO/aggregator sites. Use `maxAge: 0` when freshness matters.
- For comparisons or recommendations, dig until claims are backed by scraped evidence, and cite the URLs used. State explicitly when something could not be verified.

## Preferred CLI tools

Treat these tools as the defaults for agentic shell commands and command recommendations when they are installed:

- `rg` (ripgrep) instead of `grep` for content search.
- `fd` instead of `find` or recursive `ls` for file discovery (some Linux distributions ship the binary as `fdfind`).
- `eza` instead of `ls` for human-readable directory listings and bounded trees.
- `bat` instead of `cat` for human-readable text-file output.
- `fzf` for interactive selection and deterministic filtering of candidate lists.

Tool-calling rules:

- Prefer Pi's first-class `rg`/`fd` tools when available; otherwise invoke the corresponding CLI through the shell.
- Continue using Pi's `read` tool for model-oriented file inspection, images, offsets, and bounded reads. When shell output must display a text file, use `bat --plain --paging=never --color=never` so tool output has no pager or ANSI noise.
- Use `eza --all --long --git --group-directories-first` for directory inspection. Use `eza --tree --level=<small-number>` only for intentionally bounded trees; use `fd` for machine-oriented discovery.
- Never run bare interactive `fzf` in a non-interactive agent tool call. Use `fzf --filter <query> --select-1 --exit-0`, or use Pi's user-question UI when human judgment is required. Human-facing command suggestions may use normal interactive `fd | fzf` or `rg | fzf` pipelines.
- Use `rg -F` for literal searches containing regex metacharacters, and use `--hidden`/explicit glob exclusions only when hidden files are actually needed.
- Prefer NUL-delimited pipelines (`fd -0`, `rg -0`, `fzf --read0 --print0`) when filenames can contain whitespace or newlines.
- Do not introduce these commands into portable project scripts, minimal containers, or remote-host instructions unless those tools are declared dependencies or confirmed installed. In portability-sensitive contexts, use the platform's standard utilities.
- Do not create aliases that replace POSIX commands inside scripts, and do not rewrite working project commands solely to showcase these tools.

## Package managers

- Use the operating system's own package manager for system tools: `dnf`, `apt` or `pacman` on Linux, Homebrew on macOS, `winget` or `scoop` on Windows. Pick the one already in use on the machine.
- Do not use ad-hoc `curl | sh` installers for system tools unless the user explicitly asks. Language toolchains are the exception and are managed per language: Go from the official tarball or installer, Node via a version manager (`nvm`, `fnm`, or `nvm-windows`), Python via `uv`, Go tools via `go install`.

## Response style

Ultra caveman (`ultracave`) is the default response style for the main agent and every subagent: the `ultracave-auto` extension injects the rules from `skills/ultracave/SKILL.md` into the system prompt every turn. Switch off only with "stop caveman" or "normal mode" (confirm the switch-off in one line).

Exemptions (binding, override caveman): reports, review findings, contract or documentation text, commit messages, test names and assertions, questions asked through `ask_user`, and anything written to a file for another agent or the owner to rely on are written in plain, complete, precise prose: full sentences where ambiguity is possible; exact paths, commands, numbers, negations; evidence and reproducers intact; honest "not verified" statements intact. Compression must never remove a caveat, a negation, a number, an exit code or an honesty statement. Security warnings and irreversible actions: plain full sentences.
