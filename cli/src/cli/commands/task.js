const { getTaskContext, listTasks, assignTask, updateTaskStatus, notifyTaskDone } = require("../../core/tasks");
const { printOutput } = require("../../utils/output");

function collectRepeatedValues(value, previous = []) {
  previous.push(value);
  return previous;
}

function registerTaskCommands(program) {
  const task = program.command("task").description("Manage agent tasks");

  task
    .command("get")
    .description("Get the current task for an agent")
    .option("--agent <id>", "Agent id")
    .option("--session <id>", "Session id")
    .option("--wait", "Wait until task dependencies are satisfied")
    .option("--no-wait", "Return immediately even if task dependencies are still blocked")
    .option("--poll-interval-ms <ms>", "Polling interval while waiting", String(1500))
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const payload = await getTaskContext(process.cwd(), options);
      printOutput(options, { status: "ok", ...payload }, (result) => {
        if (!result.task) {
          return `${result.agent.id} (${result.agent.role}) has no active task.`;
        }

        const lines = [
          `${result.agent.id} (${result.agent.role})`,
          `Goal: ${result.agent.goal}`,
          `Task: ${result.task.title}`,
          `Status: ${result.task.status}`,
          `Wait state: ${result.task.waitState}`,
          `Details: ${result.task.description}`,
        ];

        if (result.task.blockingTasks && result.task.blockingTasks.length) {
          lines.push("Blocking dependencies:");
          for (const dependency of result.task.blockingTasks) {
            lines.push(`- ${dependency.dependsOnTaskId} [${dependency.dependsOnTaskStatus}] ${dependency.dependsOnTaskTitle}`);
          }
        }

        if (result.task.availableAgents && result.task.availableAgents.length) {
          lines.push("Available agents:");
          for (const agent of result.task.availableAgents) {
            lines.push(`- ${agent.id} (${agent.role}) [${agent.status}]${agent.taskTitle ? ` ${agent.taskTitle}` : ""}`);
          }
        }

        return lines.join("\n");
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
    .option("--depends-on <taskId>", "Create a blocking dependency on another task", collectRepeatedValues, [])
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

  task
    .command("notify-done")
    .description("Mark a task ready for validation and wait for finalization")
    .requiredOption("--task <id>", "Task id")
    .option("--agent <id>", "Agent id performing the update")
    .option("--session <id>", "Session id")
    .option("--note <text>", "Optional note")
    .option("--result-summary <summary>", "Summary when implementation is ready")
    .option("--poll-interval-ms <ms>", "Polling interval while waiting", String(1500))
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const result = await notifyTaskDone(process.cwd(), options);
      printOutput(options, { status: "ok", ...result }, (payload) => {
        if (payload.outcome === "finalized") {
          return `${payload.task.id} finalized. You can exit: the task is complete.`;
        }

        if (payload.outcome === "changes_requested") {
          const summary = payload.feedback.map((entry) => entry.message).join(" | ") || "Changes requested.";
          return `${payload.task.id} needs more work: ${summary}`;
        }

        return `${payload.task.id} -> ${payload.outcome}`;
      });
    });
}

module.exports = {
  registerTaskCommands,
};
