const { Command } = require("commander");
const { registerInitCommand } = require("./commands/init");
const { registerProviderCommands } = require("./commands/provider");
const { registerAgentCommands } = require("./commands/agent");
const { registerMessageCommands } = require("./commands/message");
const { registerLogsCommand } = require("./commands/logs");
const { registerEventsCommand } = require("./commands/events");

function buildProgram() {
  const program = new Command();

  program
    .name("agentsquad")
    .description("Spawn and coordinate CLI agents across providers")
    .version("1.0.0");

  registerInitCommand(program);
  registerProviderCommands(program);
  registerAgentCommands(program);
  registerMessageCommands(program);
  registerLogsCommand(program);
  registerEventsCommand(program);

  return program;
}

async function run(argv = process.argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
}

module.exports = {
  buildProgram,
  run,
};
