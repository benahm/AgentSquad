const { showLogs } = require("../../core/agents");
const { listActivityLogs } = require("../../core/activity-logs");
const { printOutput } = require("../../utils/output");

function registerLogsCommand(program) {
  program
    .command("logs")
    .description("Show activity logs")
    .argument("[agent]", "Agent id or unique name")
    .option("--session <id>", "Session id", "default")
    .option("--stdout", "Show raw agent stdout log", false)
    .option("--stderr", "Show stderr instead of stdout", false)
    .option("--follow", "Follow the selected log file", false)
    .option("--json", "Return JSON output", false)
    .action(async (agentRef, options) => {
      if (options.stdout || options.stderr || options.follow) {
        if (!agentRef) {
          throw new Error("An agent id is required when using raw stdout/stderr logs.");
        }
        await showLogs(process.cwd(), options.session, agentRef, options);
        return;
      }

      const logs = await listActivityLogs(process.cwd(), {
        session: options.session,
        agent: agentRef || undefined,
      });

      printOutput(options, { status: "ok", logs }, (payload) => {
        if (!payload.logs.length) {
          return "No activity logs found.";
        }

        return payload.logs
          .map((entry) => `${entry.createdAt} ${entry.message}`)
          .join("\n");
      });
    });
}

module.exports = {
  registerLogsCommand,
};
