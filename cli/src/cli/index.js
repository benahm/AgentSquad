const { Command } = require("commander");
const { registerInitCommand } = require("./commands/init");
const { registerProviderCommands } = require("./commands/provider");
const { registerAgentCommands } = require("./commands/agent");
const { registerMessageCommands } = require("./commands/message");
const { registerLogsCommand } = require("./commands/logs");
const { registerEventsCommand } = require("./commands/events");
const { registerTaskCommands } = require("./commands/task");
const { loadConfig } = require("../core/config");
const { executeObjective } = require("../core/orchestrator");

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
  registerTaskCommands(program);

  program
    .command("run")
    .description("Run a project objective with the orchestrator")
    .argument("<goal...>", "Project objective")
    .option("--provider <id>", "Override the orchestrator provider")
    .option("--session <id>", "Session id")
    .option("--workdir <path>", "Working directory", process.cwd())
    .option("--json", "Return JSON output", false)
    .action(async (goalParts, options) => {
      const config = await loadConfig(process.cwd());
      const result = await executeObjective(process.cwd(), config, {
        ...options,
        goal: goalParts.join(" "),
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ status: "ok", ...result }, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${result.summary}\n`);
    });

  registerProviderShortcutCommand(program, "vibe");
  registerProviderShortcutCommand(program, "codex");
  registerProviderShortcutCommand(program, "claude");

  return program;
}

async function run(argv = process.argv) {
  const directGoal = detectDirectGoal(argv);
  if (directGoal) {
    const config = await loadConfig(process.cwd());
    const result = await executeObjective(process.cwd(), config, { goal: directGoal });
    process.stdout.write(`${result.summary}\n`);
    return;
  }

  const program = buildProgram();
  await program.parseAsync(argv);
}

function detectDirectGoal(argv) {
  const first = argv[2];
  if (!first || first.startsWith("-")) {
    return null;
  }

  const knownCommands = new Set(["init", "provider", "agent", "message", "logs", "events", "task", "run", "vibe", "codex", "claude", "--help", "-h", "--version", "-V"]);
  if (knownCommands.has(first)) {
    return null;
  }

  return argv.slice(2).join(" ").trim();
}

function registerProviderShortcutCommand(program, providerId) {
  program
    .command(providerId)
    .description(`Run a project objective with ${providerId}`)
    .argument("<goal...>", "Project objective")
    .option("--session <id>", "Session id")
    .option("--workdir <path>", "Working directory", process.cwd())
    .option("--json", "Return JSON output", false)
    .action(async (goalParts, options) => {
      const config = await loadConfig(process.cwd());
      const result = await executeObjective(process.cwd(), config, {
        ...options,
        provider: providerId,
        goal: goalParts.join(" "),
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ status: "ok", ...result }, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${result.summary}\n`);
    });
}

module.exports = {
  buildProgram,
  detectDirectGoal,
  run,
};
