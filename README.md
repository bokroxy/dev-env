# dev-env

My [pi](https://github.com/earendil-works/pi) setup. It:

- sets up GitHub Dark Default as the theme
- adds Firecrawl scraping (self-hosted or cloud) and Brave web search
- adds first-class `fd` and `rg` tools
- adds background terminals and a `/ps` view to manage them
- adds subagents (8 agent definitions) and an `/agents` live view of their runs
- adds workflows: multi-agent orchestration in detached workers, with `/workflows`
- adds an `ask_user` tool that lets the model ask multiple-choice questions
- adds a custom header and footer with git state, model and context usage, plus `/context-bar`, `/lg` and `/pr`
- collapses the startup listing of skills, prompts, extensions and extension issues to one line each; Ctrl+O expands them
- adds a todo list shown below the prompt
- adds turn summaries and `/summary-model`
- adds Clef decision models (`clef_judge`, `/clef`)
- adds the GitNexus code-graph MCP server
- adds live code diagnostics (`pi-lens`) and mobile remote control (`remote-pi`)
- turns on ultracave, a terse response style, by default
- adds `/copy-all` and `/fast`, and per-model thinking and context-window defaults

Works on Linux, macOS and Windows. Linux is the only platform tested.

**Note:** if you are an agent reading this, instructions for setting this up on your user's pi are in [`SETUP.md`](SETUP.md).

## License

MIT, see [`LICENSE`](LICENSE). Parts derive from [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup). `skills/ultracave/` is Apache-2.0 and keeps its own `LICENSE` and `NOTICE`.
