# dev-env

My [pi](https://github.com/earendil-works/pi) coding-agent setup: local extensions, pinned pi packages, MCP servers, subagent definitions, one theme and a portable `AGENTS.md`. The repo root **is** the pi agent directory (`~/.pi/agent`), the same layout as [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup), which this follows.

It works on Linux, macOS and Windows. It has no install script: `SETUP.md` is written for the agent that replicates it, and it asks you the few choices that matter (Firecrawl self-hosted or cloud, which API keys you have).

**Replicate it:** tell your pi agent

> Read https://github.com/bokroxy/dev-env/blob/main/SETUP.md and set up my environment from it.

or clone the repo into `~/.pi/agent` and follow `SETUP.md` yourself.

This PC is the source of truth. Changes are made here, then copied into the repo. Do not hard-copy it blindly: it is a setup that changes, and `SETUP.md` tells the agent to ask before touching anything you already have.

## What is in it

| Path | Contents |
|---|---|
| `extensions/` | 13 local extensions plus small helpers and `shared/` (below) |
| `settings.json` | Theme, thinking level, compaction, pinned pi packages, subagent overrides. No model or account is set |
| `mcp-adapter.json` | MCP servers: `gitnexus`, `firecrawl` |
| `agents/` | 8 `pi-subagents` definitions |
| `AGENTS.md` | Portable global instructions (TypeScript, research, CLI tools, response style) |
| `skills/ultracave/` | The one skill the `ultracave-auto` extension needs (Apache-2.0, from JuliusBrussee/caveman) |
| `themes/` | `github-dark-default` |
| `package.json`, `package-lock.json` | One npm workspace for all extensions: a single `npm install` |
| `.env.example` | Names of the API keys (no values) |

### Extensions

| Extension | What it gives you |
|---|---|
| `agent-view` | `/agents`: live overlay of subagent runs and workflows |
| `background-terminals` | `bg_start`, `bg_status`, `bg_list`, `bg_kill` tools and `/ps` |
| `brave-search` | `search` tool (needs `BRAVE_API_KEY`) |
| `clef` | `clef_judge` tool and `/clef` (Cloudflare Clef decision models) |
| `context-bar` | `/context-bar`: context-usage breakdown (written for this harness) |
| `copy-all` | `/copy-all` copies the conversation to the clipboard |
| `file-search` | `fd` and `rg` as model tools; uses the system binaries, downloads a release only if missing |
| `git-info` | `/lg` and `/pr` git views and the git state used by the footer |
| `model-info`, `model-thinking-defaults.ts`, `openai-fast.ts` (`/fast`), `codex-context-window.ts` | Model state, default thinking level per model, OpenAI fast mode, Codex context window |
| `summaries` | `/summary-model` and turn recaps |
| `todo-presentation` | Below-prompt display for `@juicesharp/rpiv-todo` |
| `ui-customization` | Footer and terminal UI |
| `ultracave-auto.ts` | Injects the ultracave response-style rules every turn |
| `workflows` | `workflow` tool and `/workflows`: multi-agent orchestration in detached workers |

`eko24ive-pi-ask.json` configures the `@eko24ive/pi-ask` package (`ask_user`).

### Pi packages

Pinned in `settings.json`, installed by `pi update --extensions`: `pi-mcp-adapter`, `@juicesharp/rpiv-todo`, `pi-lens`, `@gotgenes/pi-anthropic-auth`, `remote-pi`, `@eko24ive/pi-ask`, `pi-subagents`, `@caveman-ai/middleware`.

## Not included

- Skills other than `ultracave`.
- A GitNexus embedding server. The `gitnexus` MCP server runs without one (keyword search only).
- The Linux `/tmp` launcher and guard, `ai-detector`, `paraphrase`, and the `rea` and `docs` MCP servers.
- Credentials, sessions, trust grants and model choices. `/login` and `/model` in pi set those.

## Platforms

| | Status |
|---|---|
| Linux | Developed and tested here (Fedora, Node 26.10.0, pi 1.3.0) |
| macOS | Not tested. The code paths are portable; see the notes in `SETUP.md` |
| Windows (native) | Not tested. `workflows` uses a named pipe and PowerShell for process identity; `file-search` needs `fd` and `rg` installed; the extensions' dev `test` scripts use POSIX shell syntax |

## Developing the extensions

```sh
npm install --ignore-scripts
npm run prepare --workspaces --if-present   # patches TypeScript for the Effect language service
npm test
```

`npm run check` type-checks each extension. The Effect language service reports warnings that make `tsc` exit non-zero for `file-search`; the same happens on the source machine. `todo-presentation` only type-checks after `pi update --extensions` has installed `@juicesharp/rpiv-todo`.

## License

MIT, see `LICENSE`. Parts derive from davis7dotsh/my-pi-setup (MIT, Benjamin Davis). `skills/ultracave/` is Apache-2.0 and carries its own `LICENSE` and `NOTICE`. Installed pi packages keep their own licences.
