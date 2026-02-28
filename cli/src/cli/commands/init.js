const { ensureWorkspace } = require("../../core/state");
const { ensureDatabase } = require("../../core/db");
const { printOutput } = require("../../utils/output");

function registerInitCommand(program) {
  program
    .command("init")
    .description("Initialise Agentsquad in the current project")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const workspace = await ensureWorkspace(process.cwd());
      await ensureDatabase(process.cwd());

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
