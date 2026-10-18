# `/agents` — the ai-agent view

A pi extension that opens one large overlay showing every subagent run and
workflow of the current pi session as a tree of animated personas: smooth PNG
`blobatar` avatars in Ghostty/Kitty-capable terminals (half-block fallback elsewhere),
thought bubbles with the child's real reasoning text, a separate rainbow tool feed,
ranks that promote as the run advances, a shimmering per-workflow progress bar and an
animated Clef sword with its verdict.

It is read-only. Steering, stopping and the transcript inspector stay in
pi-subagents' own `/subagents-fleet`.

## Install

```sh
# from the pi agent dir
mv extensions-disabled/agent-view extensions/agent-view
# then in the running session:
/reload
/agents
```

The extension folder carries its own `node_modules` (`blobatar`,
`@resvg/resvg-js`); copy the whole folder.

## Keys

| Key               | Action                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ↑ / ↓ (k / j)     | select an agent and keep it in view; past the last card it scrolls the body, so the last workflow's bar and the Recent list are reachable   |
| PageUp / PageDown | scroll by a screen (and past the last card, like ↓)                                                                                         |
| Enter             | inline detail pane: the tail of that child's `output-<n>.log`, or of a finished root's output (its last failed child's file)                |
| Esc               | close the pane, then the overlay                                                                                                            |
| `+` / `-`         | avatar size (6–22 px; the 60–99 column tier always draws 8 px and the footer reports the drawn size; below 60 columns there are no avatars) |
| `m`               | motion on/off                                                                                                                               |
| `f`               | running-only filter (hides the Recent list)                                                                                                 |
| `h`               | expand the Recent list past its default 5 rows                                                                                              |
| `a`               | include running runs of other pi sessions                                                                                                   |
| `q`               | close                                                                                                                                       |

## The board

The default view is a live board. **Now** shows full cards for the runs that
are actually live: a root counts as running only when its `.active-runs/<runId>`
marker exists, or (with the marker gone) when its pid is alive, its last
activity is under ten minutes old and its deadline has not passed. Anything else
that claims `running` is shown as `stale` in a warning colour: not counted, not
`live`, no ETA, no shimmer. **Recent** is one line per finished root (title,
state, when it ended, duration, tokens, cost, first line of any error), newest
first, five rows by default, `h` for the rest; every Recent line is selectable
and Enter opens its output. With nothing live the idle scene says `nothing
running · last finished 2h ago` above Recent, or `nothing running · no runs on
disk` when the runs directory is empty or absent — a missing directory is not an
error and never prints a `scan error` line. `partial`, `detached` and every state
we do not model are terminal by definition and render as `? <state>`, never as
running.

## Standalone watcher (`agents-watch`)

The same scanner and the same renderer, full-screen in its own terminal pane
(alt screen, raw mode, resize aware, `q`/Ctrl-C quits). It needs no pi process,
so the board is independent of the chat:

```sh
npm run watch                          # from this folder
agents-watch                           # the wrapper, ~/.local/bin/agents-watch
agents-watch --session <session.jsonl> # pin one pi session (then `a` shows the rest)
```

It has no pi session, so it defaults to **all** sessions. `AGENT_VIEW_RUNS_DIR`
and `AGENT_VIEW_HOME` override the run and history directories exactly as in the
overlay; `AGENTS_WATCH_SECONDS=<n>` exits after n seconds (used by the pty
smoke test).

`PI_REDUCED_MOTION=1` (or `true`) and `NO_COLOR` open the view in static mode: no
animation timer, no avatars under `NO_COLOR`, redraw only when the data changes.
In static mode a promotion skips its flourish instead of freezing it.

## Rendering and tool activity

Ghostty uses the Kitty graphics protocol automatically. Avatars are rasterized at
at least 128 pixels (16 pixels per display column), cached, and placed at the same
cell footprint as the fallback. The standalone watcher uploads each PNG once and
reuses placements; old placements are cleared during synchronized redraws and on exit.
Native-image cards use one column so image placements cannot collide in a grid.
Unsupported terminals retain half-block avatars. `PI_IMAGE_PROTOCOL=none` forces
that fallback; `NO_COLOR` hides avatars entirely.

Tool invocations never replace the reasoning bubble. Each live card has its own
bounded, newest-first rainbow feed: `Used Firecrawl!`, `Used Brave!`, `Used Higgsfield!`,
and equivalent labels for other tools. The scanner retains eight invocations and the
card shows at most three. The feed contains no arguments, paths, URLs, or result bodies;
`(failed)` marks a failed invocation. “Used” means invoked, not successfully completed.
Firecrawl calls through the MCP gateway and Higgsfield CLI invocations receive their
display labels only when those calls are actually observed.

Rank ceremonies last 5.6 seconds: anticipation, a brief sweep, centre-out banner,
a bounded sparkle burst, hold, and settle. Two ceremony rows are reserved so neighbours
do not move. At most one full burst starts per ten seconds; simultaneous promotions
keep a compact banner. A `NEW` badge remains for twenty seconds after settling.
Motion-off and reduced-motion paths skip the ceremony and show the new rank immediately.

The watcher loads source only at startup. Quit it with `q`, then run `agents-watch`
again after an update. `agents-watch --version` reports `2026-10-07-smooth-tools` for
this build. `/agents` requires a Pi extension-runtime reload to pick up source changes;
do not reload while an async workflow is running unless its interruption and relaunch
have been planned. No reload or watcher restart is performed by this implementation.

## Data

Everything comes from pi-subagents' own artifacts under
`/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/`: `status.json`,
`workflow-children.jsonl`, `events.jsonl` and `output-<n>.log`. The scanner
re-reads only files whose mtime/size changed and tails events incrementally, so
run directories created later show up within one tick (100 ms while animating).
Progress is an estimate (`~NN%`) derived from elapsed time against the median
duration of finished children of the same role, stored in
`~/.pi/agent/agent-view/durations.json`. A median is only trusted once that role
has at least three samples and it never falls below a quarter of the role's
default, a running estimate never prints `100%` (at most `~99%`), and once the
elapsed time passes the expectation the bar says `overrunning · typical Xm`
instead of `finishing`. Persona names are persisted per agent and rank in
`~/.pi/agent/agent-view/personas.json` (24 h TTL).

Anything printed for an agent is passed through `redact.ts` first — thought
bubbles, tool lines, run errors and run titles — covering token-like strings,
`Bearer`/`Authorization` values, `KEY=`/`TOKEN=`/`password=` assignments
(including JSON-quoted keys and `--password`-style flags), URL credentials,
known provider key prefixes (`sk-`, `ghp_`, `AKIA`, `AIza`, `hf_`, `npm_`),
JWTs, long hex/base64 blobs, and the home directory shortened to `~` (a long
ordinary file path is not mistaken for a blob). Redaction is a best-effort
display filter, not access control: a token that looks like a path or a file
name with an extension (for example `.../Zz9y.sig`) is not redacted, the raw
log stays on disk and the pane shows its path, so what this filter protects is
screenshots and screen sharing rather than file access.

## Development

```sh
npm install          # blobatar, @resvg/resvg-js, prettier, typescript
npm run check        # tsc --noEmit -p .
npm run test         # node --test (unit, fixtures, render harness, pty smoke)
npm run format       # prettier --write
npm run lint         # prettier --check
npm run harness      # headless mount with the real clock
npm run harness-pty  # the same inside a real pty
npm run watch        # the standalone board (needs a real terminal)
npm run watch-pty    # the standalone board inside a pty, exits after 2 s
npm run prune-durations  # drop non-done samples from durations.json (backs it up)
npm run perf         # render p50/p95 at 20 agents, 50 MB tail, 10 s CPU
```

`render.test.ts` snapshots plain-text frames (see `snapshots/` and
`test-artifacts/`); regenerate the goldens with `UPDATE_SNAPSHOTS=1 npm test`.

## Licences

- `blobatar` — MIT (avatar geometry; seed = persona name).
- `@resvg/resvg-js` — MPL-2.0 (SVG → RGBA), used unmodified as a dependency.
