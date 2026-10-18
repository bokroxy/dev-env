import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentView from "./index.ts";
import { fakeTheme, fakeTui } from "./harness.ts";
import { tempDir } from "./source/fixtures.ts";
import type { AgentViewComponent } from "./ui/view.ts";

/** Keep the handler's scanner inside a temp sandbox: never touch the real runs. */
function sandboxEnvironment(): {
  runsDir: string;
  home: string;
  restore: () => void;
} {
  const base = tempDir("agent-view-index-");
  const runsDir = path.join(base, "async-subagent-runs");
  const home = path.join(base, "agent-view");
  fs.mkdirSync(runsDir, { recursive: true });
  const previous = {
    runs: process.env.AGENT_VIEW_RUNS_DIR,
    home: process.env.AGENT_VIEW_HOME,
  };
  process.env.AGENT_VIEW_RUNS_DIR = runsDir;
  process.env.AGENT_VIEW_HOME = home;
  return {
    runsDir,
    home,
    restore: () => {
      if (previous.runs === undefined) delete process.env.AGENT_VIEW_RUNS_DIR;
      else process.env.AGENT_VIEW_RUNS_DIR = previous.runs;
      if (previous.home === undefined) delete process.env.AGENT_VIEW_HOME;
      else process.env.AGENT_VIEW_HOME = previous.home;
    },
  };
}

interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
}

function fakePi(): {
  pi: ExtensionAPI;
  commands: RegisteredCommand[];
  notifications: string[];
  emit: (event: string) => void;
  events: () => string[];
} {
  const commands: RegisteredCommand[] = [];
  const notifications: string[] = [];
  const handlers = new Map<string, (() => void)[]>();
  const fake = {
    registerCommand(
      name: string,
      options: { description?: string; handler: RegisteredCommand["handler"] },
    ) {
      commands.push({ name, ...options });
    },
    on(event: string, handler: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  // Structural fake: `registerCommand` and `on` are the only members used.
  return {
    pi: fake as unknown as ExtensionAPI,
    commands,
    notifications,
    events: () => [...handlers.keys()],
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

test("the extension registers exactly one command, /agents", () => {
  const { pi, commands } = fakePi();
  agentView(pi);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "agents");
  assert.match(commands[0].description ?? "", /live view/i);
  assert.equal(typeof commands[0].handler, "function");
});

test("the handler stays inert outside the interactive TUI", async () => {
  const sandbox = sandboxEnvironment();
  const { pi, commands } = fakePi();
  agentView(pi);
  const notifications: string[] = [];
  try {
    await commands[0].handler("", {
      hasUI: false,
      mode: "json",
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: { getSessionFile: () => undefined },
    });
  } finally {
    sandbox.restore();
  }
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /interactive terminal UI/);
});

test("the handler opens the overlay through ctx.ui.custom in tui mode", async () => {
  const sandbox = sandboxEnvironment();
  const { pi, commands } = fakePi();
  agentView(pi);
  const calls: { overlay: boolean; options: unknown }[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async (
        factory: unknown,
        options: { overlay?: boolean; overlayOptions?: unknown },
      ) => {
        calls.push({
          overlay: options.overlay === true,
          options: options.overlayOptions,
        });
        assert.equal(typeof factory, "function");
        // Do not mount: the factory would need a real TUI. Clear the handle it
        // would otherwise leave behind by never invoking it.
        return undefined;
      },
    },
    sessionManager: {
      getSessionFile: () => "/home/fixture/sessions/session-a.jsonl",
    },
  };
  try {
    await commands[0].handler("", ctx);
  } finally {
    sandbox.restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].overlay, true);
  assert.match(JSON.stringify(calls[0].options), /"width":"95%"/);
});

test("a session shutdown disposes an overlay that is still open", async () => {
  const sandbox = sandboxEnvironment();
  const previousNoColor = process.env.NO_COLOR;
  // NO_COLOR also skips the avatar engine: this test is about the timer.
  process.env.NO_COLOR = "1";
  const { pi, commands, emit, events } = fakePi();
  agentView(pi);
  assert.ok(events().includes("session_shutdown"), events().join(","));

  let component: AgentViewComponent | undefined;
  let release: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async (factory: unknown) => {
        component = await (
          factory as (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: () => void,
          ) => Promise<AgentViewComponent>
        )(fakeTui(120, 36), fakeTheme(), {}, () => {});
        // The overlay stays open until the test releases it.
        await closed;
      },
    },
    sessionManager: {
      getSessionFile: () => "/home/fixture/sessions/session-a.jsonl",
    },
  };
  const running = commands[0].handler("", ctx);
  try {
    for (
      let attempt = 0;
      attempt < 100 && component === undefined;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(component, "the overlay mounted");
    assert.equal(component.statistics.clockRunning, true);
    emit("session_shutdown");
    assert.equal(
      component.statistics.clockRunning,
      false,
      "the shutdown hook stopped the clock",
    );
    release?.();
    await running;
  } finally {
    release?.();
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    sandbox.restore();
  }
});
