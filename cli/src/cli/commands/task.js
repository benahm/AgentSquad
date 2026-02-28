const { getTaskContext, listTasks, assignTask, updateTaskStatus } = require("../../core/tasks");
const { printOutput } = require("../../utils/output");

function registerTaskCommands(program) {
  const task = program.command("task").description("Manage agent tasks");

  task
    .command("get")
    .description("Get the current task for an agent")
    .option("--agent <id>", "Agent id")
    .option("--session <id>", "Session id")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const payload = await getTaskContext(process.cwd(), options);
      printOutput(options, { status: "ok", ...payload }, (result) => {
        if (!result.task) {
          return `${result.agent.id} (${result.agent.role}) has no active task.`;
        }

        return [
          `${result.agent.id} (${result.agent.role})`,
          `Goal: ${result.agent.goal}`,
          `Task: ${result.task.title}`,
          `Status: ${result.task.status}`,
          `Details: ${result.task.description}`,
        ].join("\n");
      });
    });

  task
    .command("list")
    .description("List tasks in a session")
    .option("--session <id>", "Session id")
    .option("--agent <id>", "Filter by agent id")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const tasks = await listTasks(process.cwd(), options);
      printOutput(options, { status: "ok", tasks }, (payload) => {
        if (!payload.tasks.length) {
          return "No tasks found.";
        }

        return payload.tasks.map((entry) => `${entry.id} ${entry.agentId} [${entry.status}] ${entry.title}`).join("\n");
      });
    });

  task
    .command("assign")
    .description("Assign a task to an agent")
    .requiredOption("--agent <id>", "Agent id")
    .requiredOption("--goal <goal>", "Project goal for the task")
    .requiredOption("--task <task>", "Task description")
    .option("--title <title>", "Task title")
    .option("--session <id>", "Session id")
    .option("--status <status>", "Initial task status", "todo")
    .option("--priority <priority>", "Task priority", "medium")
    .option("--type <type>", "Task type", "other")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const assignedTask = await assignTask(process.cwd(), options);
      printOutput(options, { status: "ok", task: assignedTask }, (payload) => {
        return `Assigned ${payload.task.id} to ${payload.task.agentId}`;
      });
    });

  task
    .command("update-status")
    .description("Update the status of a task")
    .requiredOption("--task <id>", "Task id")
    .requiredOption("--status <status>", "Next status")
    .option("--blocking-reason <reason>", "Reason when blocked")
    .option("--result-summary <summary>", "Summary when completed")
    .option("--note <text>", "Optional history note")
    .option("--agent <id>", "Agent id performing the update")
    .option("--session <id>", "Session id")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const updatedTask = await updateTaskStatus(process.cwd(), options);
      printOutput(options, { status: "ok", task: updatedTask }, (payload) => {
        return `${payload.task.id} -> ${payload.task.status}`;
      });
    });
}

module.exports = {
  registerTaskCommands,
};
