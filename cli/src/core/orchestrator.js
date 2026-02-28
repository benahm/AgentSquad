const path = require("node:path");
const { createId } = require("./ids");
const { ensureDatabase, getOne, runStatement } = require("./db");
const { spawnAgent } = require("./agents");
const { sendMessage } = require("./messages");
const { appendEvent } = require("./events");
const { appendActivityLog, listActivityLogs } = require("./activity-logs");

function buildManagerPrompt(goal, provider) {
  const providerName = provider || "vibe";
  const workerCommand = `agentsquad agent run --provider ${providerName} --role <role> --goal <goal> --task <task>`;

  return [
    "You are the project manager and planner for this objective.",
    "You must create a high-level plan, identify the roles needed, and coordinate the project using the agentsquad CLI.",
    `Use the configured provider "${providerName}" for all agents and messages.`,
    `You can create worker agents with \`${workerCommand}\`.`,
    "Each worker can recover its current assignment with `agentsquad task get`.",
    "You can communicate between agents with `agentsquad message send --to <agent-id> --text <message>`.",
    "You should break the objective into concrete tasks, assign roles, and drive the project to completion.",
    "When you create a worker, give it a focused role and a crisp task.",
    "",
    `User objective: ${goal}`,
  ].join("\n");
}

async function ensureSessionRecord(cwd, config, session) {
  await ensureDatabase(cwd);
  const existing = getOne(cwd, "SELECT id FROM sessions WHERE id = ?", [session.id]);
  if (existing) {
    runStatement(
      cwd,
      "UPDATE sessions SET title = ?, goal = ?, status = ?, provider_id = ?, root_workdir = ?, updated_at = ? WHERE id = ?",
      [session.title, session.goal, session.status, session.providerId, session.rootWorkdir, session.updatedAt, session.id]
    );
    return;
  }

  runStatement(
    cwd,
    "INSERT INTO sessions (id, title, goal, status, manager_agent_id, provider_id, root_workdir, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      session.id,
      session.title,
      session.goal,
      session.status,
      session.managerAgentId || null,
      session.providerId || config.orchestrator.provider,
      session.rootWorkdir,
      session.createdAt,
      session.updatedAt,
      null,
    ]
  );
}

async function executeObjective(cwd, config, options = {}) {
  const goal = options.goal;
  const sessionId = options.session || config.defaultSession || "default";
  const provider = options.provider || (config.orchestrator && config.orchestrator.provider) || "vibe";
  const now = new Date().toISOString();
  const workdir = path.resolve(options.workdir || cwd);

  await ensureSessionRecord(cwd, config, {
    id: sessionId,
    title: options.title || goal.slice(0, 80),
    goal,
    status: "planning",
    providerId: provider,
    rootWorkdir: workdir,
    createdAt: now,
    updatedAt: now,
  });

  await appendActivityLog(cwd, {
    sessionId,
    kind: "session.start",
    message: `${provider}-planner started: planning ${JSON.stringify(goal)}`,
    details: { provider, goal },
    reporter: options.reporter,
  });

  const manager = await spawnAgent(cwd, config, {
    provider,
    session: sessionId,
    workdir,
    role: (config.orchestrator && config.orchestrator.managerRoleName) || "planner",
    goal,
    task: "Create a plan, define roles, and coordinate the project.",
    name: "manager",
    kind: "manager",
    systemPrompt: buildManagerPrompt(goal, provider),
    reporter: options.reporter,
  });

  runStatement(cwd, "UPDATE sessions SET manager_agent_id = ?, status = ?, updated_at = ? WHERE id = ?", [
    manager.id,
    "active",
    new Date().toISOString(),
    sessionId,
  ]);

  await appendEvent(cwd, sessionId, "session.objective_started", { goal, provider }, manager.id);

  const messageResult = await sendMessage(cwd, config, {
    session: sessionId,
    to: manager.id,
    text: buildManagerPrompt(goal, provider),
    kind: "instruction",
    reporter: options.reporter,
  });

  return {
    sessionId,
    goal,
    manager,
    message: messageResult.message,
    logs: await listActivityLogs(cwd, { session: sessionId }),
    summary: `Started ${manager.id} with ${provider} for objective: ${goal}`,
  };
}

module.exports = {
  buildManagerPrompt,
  executeObjective,
};
