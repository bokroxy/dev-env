# Independent workflows (Pi 1.0)

Workflows execute in detached Node workers, not in the session that launched them.
Closing the terminal, quitting Pi, reloading extensions, or pressing Esc on a
foreground waiter does **not** cancel a newly launched independent workflow.

Reload Pi to load this version. **Let old session-owned workflows finish before
reloading**: already-running workflows cannot be transferred to a new process.

## Controls

Open `/workflows` from any Pi session, including a new session in another project.
Independent runs remain visible after completion, failure or interruption.

- **p**: pause the selected run; press again to resume (also cancels a pending pause).
- **x, then x within four seconds**: explicitly cancel the selected run.
- Existing navigation, transcript viewing and **s** (save report) still work.

Commands also work without opening the dashboard:

```text
/workflows pause wf_<id>
/workflows resume wf_<id>
/workflows cancel wf_<id>
/workflows status wf_<id>
/workflows wf_<id>
```

An unambiguous ID suffix is accepted. Interactive cancellation asks for confirmation.
Cancellation stops execution; it does not remove artifacts or undo completed edits.
Never delete a run directory to stop a workflow.

## Progress below the prompt

In normal chat, workflows launched by **this session** automatically get one
phase-coloured bar each, **below the prompt/editor**. Foreign-session workflows
never appear here; the `/workflows` dashboard still provides cross-session access.
Both foreground and background runs are included. No model request is needed to
render or refresh the bars.

- Phase colours remain consistent within a run. `█` represents settled known work,
  `▒` in-flight work, and `░` pending/unvisited work.
- Failed agents appear as **solid red portions** inside their phase. The outcome
  says **Finished with errors**, never a misleading `done`, when a completed script
  contains agent errors. Counts distinguish **succeeded**, **failed** and **in progress**.
- Normal chat stays compact: each workflow is exactly **three rows** (outcome,
  bar, phase summary). Failed-agent names, recorded errors and script errors are
  deliberately **not** repeated there; open `/workflows` for per-agent detail,
  transcripts and the actual error. This keeps many concurrent or historical
  workflows from cluttering the view.
- Bars are capped at 96 columns for readability on ultrawide terminals. Terminal
  unrun phases are collapsed into **N phases not run**, not drawn as giant pending
  blocks. Future agent counts and phase costs are unknown, so no percentage is invented.
- **Finished bars stay in place.** A later workflow reuses the oldest eligible
  finished slot. Active, pausing and paused workflows are never replaced; all
  concurrent session-owned runs remain visible.
- The layout restores from run timestamps on reload/resume and resets when the
  session changes. Updating/removing a widget never deletes or controls a run.

## Pause contract

Pause is enforced by the harness, not by asking an agent to cooperate.

1. New agents, tool calls and SDK model requests wait at admission gates.
2. Already-admitted tools/model requests are allowed to finish. Status is **pausing**
   while they drain; they may still edit files or complete remote actions.
3. Status becomes **paused** when tracked operations have drained. Live agent
   conversations, pending promises and orchestration state stay in the worker's RAM.
4. Resume opens the gates on that same execution. No script replay or deletion occurs.

A current tool may finish its nested calls; blocking them would deadlock its drain.
Virtual-model routing is similarly treated as part of an admitted request.
Uncooperative timed-out tool promises remain tracked instead of falsely reporting
that their side effects have stopped. A stalled admitted first request retains its
45-second watchdog. Time spent waiting for admission does not consume that watchdog
or a tool's three-minute execution deadline. Child cache warming is disabled only in
in-memory settings, and the launch-time project trust decision is preserved.

Pause is **not** an OS process freeze, rollback, or sandbox for arbitrary extension
code. Previously launched background commands and remote jobs may continue after the
launching tool returns. Pure orchestration bookkeeping may continue, but no new agent,
SDK model request or guarded tool operation is admitted. Wait for **paused** before
assuming admitted operations are quiescent; use explicit cancel if necessary.

## Lifetime and recovery

The worker has its own process session, file-backed stdout/stderr, and a private local
control endpoint (Unix socket, or a named pipe on Windows). Pi only polls artifacts and sends explicit control requests. The
session shutdown hook stops its monitor, never the worker.

- Linux is the tested platform. macOS (process identity via `ps`) and Windows (identity via PowerShell, control over a named pipe) are implemented but untested; the machine must stay running. Survival of a full OS logout depends on
  login/session supervision and is not promised. This is not a boot-persistent service.
- Paused workers use RAM; they are not serialized execution checkpoints.
- A reboot, worker crash, or lost worker identity is shown as **interrupted**. Files
  remain available. Such runs are **not automatically replayed or resumed** because
  doing so could repeat side-effecting tools.
- Workers load normal trusted resources, providers and stored/environment credentials
  independently. Parent-only transient credentials or extension state are not copied.
- Background completion follows up to the launching session in TUI/RPC mode. Reopening
  that same session reconciles missed results. Persisted follow-up messages serve as
  delivery receipts; a result already in the transcript is not sent again. All results
  are also accessible from another session's dashboard. Print-mode callers should
  inspect the artifacts/status rather than expect a follow-up after their process exits.

## Artifacts

Under `~/.pi/agent/workflows/wf_<id>/`:

| File | Purpose |
| --- | --- |
| `launch.json` | Captured script, args, cwd, model metadata and trust choice |
| `script.js`, `args.json` | Original inputs |
| `workflow.json` | Live state and final metadata |
| `transcripts.json` | Bounded per-agent transcripts |
| `result.json` | Final bounded result, when available |
| `worker.json` | PID, boot identity and process start identity (guards against PID reuse) |
| `worker.log` | Worker diagnostics |
| `control.sock` | Private local control endpoint while the worker lives (Unix; a hashed socket under the temp dir if the path is too long, a named pipe on Windows) |
| `report.md` | Optional dashboard-exported report |

New run directories are private (`0700`); control sockets and logs are `0600`.
Pause, resume and cancel never remove inputs, results or transcripts. Socket teardown
only removes the ephemeral communication endpoint.

## Development

From this directory:

```sh
npm run check
npm test
npm run format
npm run lint
```

Tests use local fixtures and fake model streams, not paid model calls. They cover
parent exit, reconnect/resume, cancellation with retained files, crash/PID reuse,
late tool registration, nested calls, direct SDK model requests, virtual routing,
watchdogs, project trust, completion delivery, dashboard keyboard controls,
session-scoped progress widgets, retention/replacement, failure visibility and
terminal-width/label safety.

`tsconfig.json` targets the installed Pi 1.0 SDK declarations; update its paths when
upgrading the harness. The worker bootstrap resolves SDK modules from the launching
Pi installation rather than accidentally loading an older global SDK.
