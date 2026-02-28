const { ensureWorkspace } = require("../../core/state");
const { ensureSessionStore } = require("../../core/store");
const { printOutput } = require("../../utils/output");

function registerInitCommand(program) {
  program
    .command("init")
    .description("Initialise Agentsquad in the current project")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const workspace = await ensureWorkspace(process.cwd());
      await ensureSessionStore(process.cwd(), "default");

      printOutput(options, {
        status: "ok",
        message: "Agentsquad workspace initialised",
        workspaceRoot: workspace.root,
      });
    });
}

module.exports = {
  registerInitCommand,
};
