const { loadConfig } = require("../../core/config");
const { spawnAgent, listAgents, showAgent, stopAgent } = require("../../core/agents");
const { printOutput } = require("../../utils/output");

function registerAgentCommands(program) {
  const agent = program.command("agent").description("Manage agents");

  agent
    .command("run")
    .description("Run a managed agent")
    .option("--provider <id>", "Provider id")
    .option("--role <role>", "Agent role", "worker")
    .option("--goal <goal>", "Goal assigned to the agent")
    .option("--task <task>", "Current task to assign")
    .option("--name <name>", "Human-friendly agent name")
    .option("--session <id>", "Session id", "default")
    .option("--workdir <path>", "Working directory", process.cwd())
    .option("--profile <name>", "Provider profile")
    .option("--env <pair...>", "Environment overrides as KEY=VALUE")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const config = await loadConfig(process.cwd());
      const agentRecord = await spawnAgent(process.cwd(), config, {
        ...options,
        autoStart: true,
        provider: options.provider || config.orchestrator.provider || "vibe",
      });
      printOutput(options, {
        status: "ok",
        agent: agentRecord,
      }, (payload) => `Created ${payload.agent.id} (${payload.agent.providerId}, ${payload.agent.role})`);
    });

  agent
    .command("list")
    .description("List agents in a session")
    .option("--session <id>", "Session id", "default")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const agents = await listAgents(process.cwd(), options.session);
      printOutput(options, {
        status: "ok",
        agents,
      }, (payload) => {
        if (!payload.agents.length) {
          return "No agents found.";
        }

        return payload.agents
          .map((entry) => `${entry.id} [${entry.status}] ${entry.providerId} ${entry.role}${entry.name ? ` ${entry.name}` : ""}`)
          .join("\n");
      });
    });

  agent
    .command("show")
    .description("Show details for one agent")
    .argument("<agent>", "Agent id or unique name")
    .option("--session <id>", "Session id", "default")
    .option("--json", "Return JSON output", false)
    .action(async (agentRef, options) => {
      const agentRecord = await showAgent(process.cwd(), options.session, agentRef);
      printOutput(options, {
        status: "ok",
        agent: agentRecord,
      });
    });

  agent
    .command("stop")
    .description("Stop a running detached agent")
    .argument("<agent>", "Agent id or unique name")
    .option("--session <id>", "Session id", "default")
    .option("--json", "Return JSON output", false)
    .action(async (agentRef, options) => {
      const result = await stopAgent(process.cwd(), options.session, agentRef);
      printOutput(options, {
        status: "ok",
        ...result,
      }, (payload) => payload.message);
    });
}

module.exports = {
  registerAgentCommands,
};
