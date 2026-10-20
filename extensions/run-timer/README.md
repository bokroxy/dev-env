# Prompt timing

Every prompt in the interactive terminal UI gets a live elapsed timer and a saved completion row. No configuration, credentials or external tools are required.

While a prompt runs, the spinner shows `Working · 1m 32s`. The footer appends the elapsed time after its existing cost and tokens-per-second fields. When the prompt finishes, the footer shows `took 1m 32s` and a separate row beneath the final reply records its completion time and duration:

```text
✓ 22:14:07 · took 4m 12s
```

An interrupted run uses `■` and adds `interrupted`; a failed run uses `✗` and adds `failed`. Press Ctrl+O to expand the row and see its start time as well.

## Timing and persistence

- Times use the local 24-hour clock. Rows from earlier days include the date, and rows from another year also include the year.
- Elapsed time includes tool calls, waits for user input and retries within the same run. It stops at the final agent-loop end, excluding later settlement work such as recap generation.
- One row is saved per settled run, not per tool call or intermediate reply. Queued follow-ups within that run share its original start time.
- Timing rows persist as custom session entries and reappear on resume. They are not sent to the model and do not consume model context. The footer restores the last saved duration from the current session branch.
- Print mode, RPC mode and subagents do not start the timer.

The extension publishes `dashboard:run-timer` events for `ui-customization`. The completion row and spinner still work without that footer extension. Shared formatting lives in `extensions/shared/time-format.ts`.

Restart pi or run `/reload` after adding these files to an existing setup.

## Verification

From the repository root:

```sh
npm run check --workspace=run-timer --workspace=ui-customization
npm run test --workspace=run-timer --workspace=ui-customization
```
