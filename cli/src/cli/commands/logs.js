const { showLogs } = require("../../core/agents");

function registerLogsCommand(program) {
  program
    .command("logs")
    .description("Show agent logs")
    .argument("<agent>", "Agent id or unique name")
    .option("--session <id>", "Session id", "default")
    .option("--stderr", "Show stderr instead of stdout", false)
    .option("--follow", "Follow the selected log file", false)
    .action(async (agentRef, options) => {
      await showLogs(process.cwd(), options.session, agentRef, options);
    });
}

module.exports = {
  registerLogsCommand,
};
