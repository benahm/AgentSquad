const path = require("node:path");
const { spawnAgent } = require("./agents");
const { sendMessage } = require("./messages");
const { appendEvent } = require("./events");
const { appendActivityLog, listActivityLogs } = require("./activity-logs");
const { appendSnapshot, readSession, readSnapshots } = require("./store");

function buildManagerPrompt(goal, provider) {
  const providerName = provider || "vibe";
  const workerCommand = `agentsquad agent run --provider ${providerName} --role <role> --goal <goal> --task <task>`;

  return [
    "You are the project manager and planner for this objective.",
    "You must create a high-level plan, identify the roles needed, and coordinate the project using the agentsquad CLI.",
    `Use the configured provider "${providerName}" for all agents and messages.`,
    `You can create worker agents with \`${workerCommand}\`.`,
    "Each worker can recover its current assignment with `agentsquad task get --wait`.",
    "You can communicate between agents with `agentsquad message send --to <agent-id> --text <message>`.",
    "You should break the objective into concrete tasks, assign roles, define dependencies between tasks at assignment time, and drive the project to completion.",
    "When you create a worker, give it a focused role and a crisp task.",
    "Launch workers immediately even if some tasks are blocked by dependencies.",
    "Use `agentsquad task assign --depends-on <task-id>` to define blocking dependencies between tasks.",
    "A tester or reviewer should only receive work after upstream blocking tasks are complete; `task get --wait` handles that automatically.",
    "Developers should use `agentsquad task notify-done --task <task-id>` when they think implementation is complete.",
    "Testers and reviewers should use `agentsquad task update-status --status done` when validation passes.",
    "If testing fails, testers and reviewers should use `agentsquad task update-status --status blocked --note \"...\"` so the upstream developer task is reopened automatically.",
    "",
    `User objective: ${goal}`,
  ].join("\n");
}

async function getExistingManager(cwd, sessionId) {
  const session = await readSession(cwd, sessionId);
  if (!session || !session.managerAgentId) {
    return null;
  }

  const agents = await readSnapshots(cwd, sessionId, "agents");
  return agents.find((entry) => entry.id === session.managerAgentId && !entry.archivedAt) || null;
}

async function ensureSessionRecord(cwd, config, session) {
  const existing = await readSession(cwd, session.id);
  if (existing) {
    await appendSnapshot(cwd, session.id, "session", {
      ...existing,
      title: session.title,
      goal: session.goal,
      status: session.status,
      providerId: session.providerId || config.orchestrator.provider,
      rootWorkdir: session.rootWorkdir,
      updatedAt: session.updatedAt,
    });
    return;
  }

  await appendSnapshot(cwd, session.id, "session", {
    id: session.id,
    title: session.title,
    goal: session.goal,
    status: session.status,
    managerAgentId: session.managerAgentId || null,
    providerId: session.providerId || config.orchestrator.provider,
    rootWorkdir: session.rootWorkdir,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: null,
  });
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

  const existingManager = await getExistingManager(cwd, sessionId);
  if (existingManager) {
    const session = await readSession(cwd, sessionId);
    await appendSnapshot(cwd, sessionId, "session", {
      ...session,
      status: "active",
      updatedAt: new Date().toISOString(),
    });

    await appendActivityLog(cwd, {
      sessionId,
      agentId: existingManager.id,
      kind: "session.reuse_manager",
      message: `${provider}-planner reused existing manager ${existingManager.id}`,
      details: { provider, goal, managerAgentId: existingManager.id },
      reporter: options.reporter,
    });

    return {
      sessionId,
      goal,
      manager: existingManager,
      message: null,
      logs: await listActivityLogs(cwd, { session: sessionId }),
      summary: `Reused ${existingManager.id} for objective: ${goal}`,
    };
  }

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

  const session = await readSession(cwd, sessionId);
  await appendSnapshot(cwd, sessionId, "session", {
    ...session,
    managerAgentId: manager.id,
    status: "active",
    updatedAt: new Date().toISOString(),
  });

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
