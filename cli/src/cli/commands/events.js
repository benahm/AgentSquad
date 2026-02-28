const { listEvents } = require("../../core/events");
const { printOutput } = require("../../utils/output");

function registerEventsCommand(program) {
  program
    .command("events")
    .description("List session events")
    .option("--session <id>", "Session id", "default")
    .option("--agent <agent>", "Filter by agent id")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const events = await listEvents(process.cwd(), options);
      printOutput(options, {
        status: "ok",
        events,
      }, (payload) => {
        if (!payload.events.length) {
          return "No events found.";
        }

        return payload.events
          .map((entry) => `${entry.timestamp} ${entry.type}${entry.agentId ? ` ${entry.agentId}` : ""}`)
          .join("\n");
      });
    });
}

module.exports = {
  registerEventsCommand,
};
