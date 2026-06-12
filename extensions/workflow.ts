import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActiveWorkflowStore, createWorkflowInspector, createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const activeWorkflowStore = createActiveWorkflowStore();
  const workflowTool = createWorkflowTool({
    activeWorkflowStore,
    hostToolNames: () => pi.getActiveTools().filter((name) => name !== "workflow"),
  });
  pi.registerTool(workflowTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });

  pi.registerCommand("workflow", {
    description: "Inspect the active workflow",
    handler: async (_args, ctx) => {
      const activeWorkflow = activeWorkflowStore.current;
      if (!activeWorkflow) {
        if (ctx.hasUI) ctx.ui.notify("No active workflow", "info");
        return;
      }
      if (!ctx.hasUI) return;

      await ctx.ui.custom<void>(
        (tui, _theme, keybindings, done) =>
          createWorkflowInspector(activeWorkflow, tui, keybindings, done, () => ctx.ui.getToolsExpanded()),
        { overlay: true, overlayOptions: { anchor: "center", width: 96 } },
      );
    },
  });
}
