const { loadConfig } = require("../../core/config");
const { sendMessage, listMessages } = require("../../core/messages");
const { printOutput } = require("../../utils/output");

function registerMessageCommands(program) {
  const message = program.command("message").description("Persist and deliver messages");

  message
    .command("send")
    .description("Send a message to an agent")
    .requiredOption("--to <agent>", "Target agent id or unique name")
    .option("--from <agent>", "Source agent id or unique name")
    .option("--session <id>", "Session id", "default")
    .option("--text <text>", "Inline message text")
    .option("--file <path>", "Read message text from a file")
    .option("--related-task-id <id>", "Related task id")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const config = await loadConfig(process.cwd());
      const result = await sendMessage(process.cwd(), config, options);
      printOutput(options, {
        status: "ok",
        ...result,
      }, (payload) => `${payload.message.id} -> ${payload.message.to} (${payload.message.deliveryStatus})`);
    });

  message
    .command("list")
    .description("List persisted messages")
    .option("--session <id>", "Session id", "default")
    .option("--agent <agent>", "Filter by sender or recipient")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const messages = await listMessages(process.cwd(), options);
      printOutput(options, {
        status: "ok",
        messages,
      }, (payload) => {
        if (!payload.messages.length) {
          return "No messages found.";
        }

        return payload.messages
          .map((entry) => `${entry.id} ${entry.from || "user"} -> ${entry.to} [${entry.deliveryStatus}]`)
          .join("\n");
      });
    });
}

module.exports = {
  registerMessageCommands,
};
