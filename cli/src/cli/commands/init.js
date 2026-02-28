const { ensureWorkspace, getConfigPath, writeJsonFile, pathExists } = require("../../core/state");
const { defaultConfig } = require("../../core/config");
const { printOutput } = require("../../utils/output");

function registerInitCommand(program) {
  program
    .command("init")
    .description("Initialise Agentsquad in the current project")
    .option("-f, --force", "Overwrite an existing config file", false)
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const workspace = await ensureWorkspace(process.cwd());
      const configPath = getConfigPath(process.cwd());
      const exists = await pathExists(configPath);

      if (exists && !options.force) {
        printOutput(options, {
          status: "skipped",
          message: "agentsquad.config.json already exists",
          configPath,
          workspaceRoot: workspace.root,
        });
        return;
      }

      await writeJsonFile(configPath, defaultConfig());

      printOutput(options, {
        status: "ok",
        message: "Agentsquad initialised",
        configPath,
        workspaceRoot: workspace.root,
      });
    });
}

module.exports = {
  registerInitCommand,
};
