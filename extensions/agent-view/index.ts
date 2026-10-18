/**
 * `/agents` — the live agent view.
 *
 * Opens a large overlay listing every subagent run and workflow of this pi
 * session (plus running runs of other sessions on `a`), and keeps showing ones
 * that start later: run directories are discovered by scanning, so a workflow
 * that starts while the overlay is open appears on the next tick, and finished
 * children collapse to a dim line instead of disappearing.
 *
 * Everything is read-only: pi-subagents' own `/subagents-fleet` inspector keeps
 * ownership of steering and stopping.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import { createAvatarEngine } from "./avatar/poses.ts";
import { defaultHistoryDir, PersonaStore } from "./source/history.ts";
import { defaultRunsDir, RunScanner } from "./source/runs.ts";
import { AgentViewComponent } from "./ui/view.ts";
import { createStyles } from "./ui/style.ts";

const OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "center",
  width: "95%",
  minWidth: 40,
  maxHeight: "85%",
  margin: 1,
};

/** `1`, `true`, `yes` and `on` mean set; an empty value, `0` and `false` do not. */
export function envFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

export default function agentView(pi: ExtensionAPI) {
  // pi disposes the component only through `close()`, so an overlay that is
  // still open when pi shuts down would never save its personas or stop its
  // clock. `dispose()` is idempotent, so both paths may run.
  let overlay: AgentViewComponent | undefined;
  pi.on("session_shutdown", () => {
    overlay?.dispose();
    overlay = undefined;
  });

  pi.registerCommand("agents", {
    description:
      "Live view of running and upcoming subagent workflows and runs: avatars, thought bubbles, progress",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(
          "The agent view needs the interactive terminal UI.",
          "info",
        );
        return;
      }

      const runsDir = process.env.AGENT_VIEW_RUNS_DIR ?? defaultRunsDir();
      const historyDir = process.env.AGENT_VIEW_HOME ?? defaultHistoryDir();
      const environment = {
        // no-color.org: any non-empty value means "no colour".
        noColor: (process.env.NO_COLOR ?? "") !== "",
        reducedMotion: envFlag(process.env.PI_REDUCED_MOTION),
      };

      const scanner = new RunScanner({
        runsDir,
        sessionFile: ctx.sessionManager.getSessionFile(),
        historyDir,
      });
      scanner.poll();

      await ctx.ui.custom(
        async (tui, theme, _keybindings, done) => {
          const styles = createStyles(theme, environment);
          const avatar = environment.noColor
            ? undefined
            : await createAvatarEngine({ style: styles.halfBlock });
          const component = new AgentViewComponent({
            scanner,
            theme,
            tui,
            done,
            environment,
            ...(avatar ? { avatar } : {}),
            personaStore: new PersonaStore(
              path.join(historyDir, "personas.json"),
            ),
          });
          overlay = component;
          component.start();
          return component;
        },
        { overlay: true, overlayOptions: OVERLAY_OPTIONS },
      );
      // The overlay is closed: release what it holds, whether pi or the user
      // closed it.
      overlay?.dispose();
      overlay = undefined;
    },
  });
}
