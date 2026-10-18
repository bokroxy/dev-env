import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import registerTodos from "../../npm/node_modules/@juicesharp/rpiv-todo/index.ts";
import { TodoOverlay } from "../../npm/node_modules/@juicesharp/rpiv-todo/todo-overlay.ts";
import { belowPromptTodoUI } from "./presentation.ts";

export class BelowPromptTodoOverlay extends TodoOverlay {
  override setUICtx(ui: ExtensionUIContext) {
    super.setUICtx(belowPromptTodoUI(ui));
  }
}

/** Reuse upstream tool/replay/store; substitute only its documented importer seam. */
export default function todoPresentation(pi: ExtensionAPI) {
  registerTodos(pi, async () => ({ TodoOverlay: BelowPromptTodoOverlay }));
}
