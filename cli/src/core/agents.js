const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureWorkspace, ensureAgentWorkspace, getAgentsRoot, getWorkspaceRoot, pathExists, readJsonFile, writeJsonFile } = require("./state");
const { createId } = require("./ids");
const { appendEvent } = require("./events");
const { appendActivityLog } = require("./activity-logs");
const { AgentsquadError } = require("./errors");
const { buildAgentId, generateAgentName } = require("./agent-naming");
const { createTask } = require("./tasks");
const { resolveProvider, mergeProviderConfig } = require("../providers/adapter-registry");
const { startDetachedProcess, readPid, isPidAlive, stopPid } = require("./process-manager");
const { appendSnapshot, readSession, readSnapshots } = require("./store");

async function listAgents(cwd, sessionId = "default") {
  await ensureWorkspace(cwd, sessionId);
  const persistedAgents = (await readSnapshots(cwd, sessionId, "agents"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (persistedAgents.length) {
    const hydrated = [];
    for (const agent of persistedAgents) {
      hydrated.push(await hydrateAgentRuntime(cwd, sessionId, agent));
    }
    return hydrated;
  }

  const agentsRoot = getAgentsRoot(cwd, sessionId);
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  const agents = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const agentPath = path.join(agentsRoot, entry.name, "agent.json");
    if (!(await pathExists(agentPath))) {
      continue;
    }

    const agent = await readJsonFile(agentPath);
    agents.push(await hydrateAgentRuntime(cwd, sessionId, agent));
  }

  return agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function hydrateAgentRuntime(cwd, sessionId, agent) {
  const agentWorkspace = await ensureAgentWorkspace(cwd, sessionId, agent.id);
  const pidMeta = await readPid(agentWorkspace.pidPath);

  if (pidMeta && isPidAlive(pidMeta.pid)) {
    return {
      ...agent,
      pid: pidMeta.pid,
      status: agent.mode === "detached" ? "running" : agent.status,
    };
  }

  if (agent.mode === "detached" && agent.status === "running") {
    return {
      ...agent,
      status: "stopped",
    };
  }

  return agent;
}

async function resolveAgent(cwd, sessionId, agentRef) {
  const agents = await listAgents(cwd, sessionId);
  const byId = agents.find((entry) => entry.id === agentRef);
  if (byId) {
    return byId;
  }

  const byName = agents.filter((entry) => entry.name === agentRef);
  if (byName.length > 1) {
    throw new AgentsquadError("AMBIGUOUS_AGENT_NAME", `Multiple agents match "${agentRef}". Use the id instead.`);
  }

  if (byName.length === 1) {
    return byName[0];
  }

  throw new AgentsquadError("AGENT_NOT_FOUND", `No agent found for "${agentRef}".`);
}

async function persistAgent(cwd, sessionId, agent) {
  const workspace = await ensureAgentWorkspace(cwd, sessionId, agent.id);
  await writeJsonFile(workspace.agentPath, agent);
  await appendSnapshot(cwd, sessionId, "agents", agent);
  return workspace;
}

async function persistSession(cwd, sessionId, sessionPatch) {
  const existing = await readSession(cwd, sessionId);
  const next = {
    ...(existing || {}),
    ...sessionPatch,
    id: sessionId,
  };
  await appendSnapshot(cwd, sessionId, "session", next);
  return next;
}

async function spawnAgent(cwd, config, options) {
  const sessionId = options.session || config.defaultSession || "default";
  await ensureWorkspace(cwd, sessionId);

  const providerConfig = mergeProviderConfig(config, options.provider, options.profile);
  const adapter = resolveProvider(options.provider);
  const now = new Date().toISOString();
  const workdir = path.resolve(options.workdir || cwd);
  const workspaceRoot = getWorkspaceRoot(cwd);
  const role = options.role || "worker";
  const name = options.name || generateAgentName(Date.now());
  const agentId = await createHumanReadableAgentId(cwd, sessionId, name, role);

  await persistSession(cwd, sessionId, {
    title: sessionId,
    goal: options.goal || `Session ${sessionId}`,
    status: "active",
    managerAgentId: null,
    providerId: options.provider,
    rootWorkdir: workdir,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });

  const agent = {
    id: agentId,
    name,
    role,
    kind: options.kind || "worker",
    providerId: options.provider,
    profile: options.profile || null,
    sessionId,
    workdir,
    goal: options.goal || "Support the project goal",
    createdAt: now,
    updatedAt: now,
    status: providerConfig.mode === "detached" ? "starting" : "idle",
    mode: providerConfig.mode || "oneshot",
    env: normalizeEnv(options.env),
    parentAgentId: options.parentAgentId || null,
    createdByAgentId: options.createdByAgentId || null,
    systemPrompt: options.systemPrompt || null,
    currentTaskId: null,
    launchCommand: null,
    lastHeartbeatAt: null,
    archivedAt: null,
  };
  agent.env.AGENTSQUAD_WORKSPACE_ROOT = workspaceRoot;
  if ((options.provider === "vibe" || options.provider === "mistral-vibe") && !agent.env.VIBE_HOME) {
    agent.env.VIBE_HOME = path.join(workspaceRoot, "vibe-home");
    await fs.mkdir(path.join(agent.env.VIBE_HOME, "logs"), { recursive: true });
  }

  const workspace = await persistAgent(cwd, sessionId, agent);
  const launchCommand = [providerConfig.command, ...(providerConfig.args || [])].join(" ");
  agent.launchCommand = launchCommand;
  await persistAgent(cwd, sessionId, agent);

  await appendSnapshot(cwd, sessionId, "agentRuns", {
    id: createId("run"),
    agentId: agent.id,
    sessionId,
    providerId: agent.providerId,
    command: providerConfig.command,
    argsJson: JSON.stringify(providerConfig.args || []),
    pid: null,
    exitCode: null,
    exitSignal: null,
    status: providerConfig.mode === "detached" ? "starting" : "completed",
    stdoutPath: workspace.stdoutPath,
    stderrPath: workspace.stderrPath,
    startedAt: now,
    endedAt: providerConfig.mode === "detached" ? null : now,
  });

  if (providerConfig.mode === "detached") {
    const invocation = adapter.createSpawnInvocation(agent, providerConfig);
    const pid = await startDetachedProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdoutPath: workspace.stdoutPath,
      stderrPath: workspace.stderrPath,
      pidPath: workspace.pidPath,
    });

    agent.pid = pid;
    agent.status = "running";
    agent.updatedAt = new Date().toISOString();
    await persistAgent(cwd, sessionId, agent);
  }

  if (options.task) {
    const task = await createTask(cwd, {
      sessionId,
      agentId: agent.id,
      title: options.taskTitle || options.task,
      goal: agent.goal,
      description: options.task,
      status: "todo",
      priority: options.priority || "medium",
      taskType: options.taskType || inferTaskType(role),
      acceptanceCriteria: options.acceptanceCriteria || null,
      createdByAgentId: agent.createdByAgentId,
      reporter: options.reporter,
    });
    agent.currentTaskId = task.id;
    agent.updatedAt = new Date().toISOString();
    await persistAgent(cwd, sessionId, agent);
  }

  await appendEvent(cwd, sessionId, "agent.spawned", {
    providerId: agent.providerId,
    workdir: agent.workdir,
    mode: agent.mode,
    role: agent.role,
  }, agent.id);

  await appendActivityLog(cwd, {
    sessionId,
    agentId: agent.id,
    message: `${agent.id} started: ${options.task || agent.goal}`,
    kind: "agent.lifecycle",
    reporter: options.reporter,
    details: {
      providerId: agent.providerId,
      role: agent.role,
      task: options.task || null,
    },
  });

  if (shouldAutoStartAgent(agent, options)) {
    const { sendMessage } = require("./messages");
    await sendMessage(cwd, config, {
      session: sessionId,
      to: agent.id,
      text: buildAgentKickoffPrompt(agent),
      kind: "instruction",
      reporter: options.reporter,
    });
  }

  return agent;
}

function normalizeEnv(entries) {
  if (!entries || !entries.length) {
    return {};
  }

  return entries.reduce((accumulator, entry) => {
    const [key, ...rest] = entry.split("=");
    if (!key || !rest.length) {
      return accumulator;
    }

    accumulator[key] = rest.join("=");
    return accumulator;
  }, {});
}

async function showAgent(cwd, sessionId, agentRef) {
  return resolveAgent(cwd, sessionId, agentRef);
}

async function stopAgent(cwd, sessionId, agentRef) {
  const agent = await resolveAgent(cwd, sessionId, agentRef);
  const workspace = await ensureAgentWorkspace(cwd, sessionId, agent.id);

  if (agent.mode !== "detached") {
    throw new AgentsquadError("AGENT_NOT_RUNNING", `${agent.id} is not a detached process.`);
  }

  const result = await stopPid(workspace.pidPath);
  const next = {
    ...agent,
    status: "stopped",
    updatedAt: new Date().toISOString(),
  };
  await persistAgent(cwd, sessionId, next);
  await appendEvent(cwd, sessionId, "agent.stopped", { pid: result.pid }, agent.id);
  await appendActivityLog(cwd, {
    sessionId,
    agentId: agent.id,
    kind: "agent.lifecycle",
    message: `${agent.id} stopped`,
  });

  return {
    agent: next,
    message: result.stopped ? `Stopped ${agent.id}.` : `${agent.id} was already stopped.`,
  };
}

async function showLogs(cwd, sessionId, agentRef, options) {
  const agent = await resolveAgent(cwd, sessionId, agentRef);
  const workspace = await ensureAgentWorkspace(cwd, sessionId, agent.id);
  const logPath = options.stderr ? workspace.stderrPath : workspace.stdoutPath;

  if (options.follow) {
    await followLog(logPath);
    return;
  }

  if (!(await pathExists(logPath))) {
    return;
  }

  const content = await fs.readFile(logPath, "utf8");
  process.stdout.write(content);
}

async function followLog(logPath) {
  await new Promise((resolve, reject) => {
    const child = spawn("tail", ["-n", "50", "-f", logPath], {
      stdio: "inherit",
    });

    child.on("close", () => resolve());
    child.on("error", reject);
  });
}

async function createHumanReadableAgentId(cwd, sessionId, name, role) {
  let index = 0;
  while (true) {
    const candidate = buildAgentId(name, role, index);
    const existing = (await readSnapshots(cwd, sessionId, "agents")).find((entry) => entry.id === candidate);
    if (!existing) {
      return candidate;
    }
    index += 1;
  }
}

function inferTaskType(role) {
  const normalized = String(role || "").toLowerCase();
  if (normalized.includes("plan")) {
    return "planning";
  }
  if (normalized.includes("test")) {
    return "testing";
  }
  if (normalized.includes("review")) {
    return "review";
  }
  if (normalized.includes("dev")) {
    return "implementation";
  }
  return "other";
}

function shouldAutoStartAgent(agent, options) {
  return agent.mode === "oneshot"
    && options.autoStart === true
    && Boolean(agent.currentTaskId)
    && agent.kind !== "manager";
}

function buildAgentKickoffPrompt(agent) {
  return [
    `You are ${agent.role || "a worker"} for this objective: ${agent.goal}.`,
    "Start working on your assigned task now.",
    "First, run `agentsquad task get --wait` to load the active task details and dependency state.",
    "If the task is ready, complete the requested work in the project workspace and keep outputs concrete.",
    "If you are implementing something, create or edit the necessary files directly.",
    "When your implementation task is ready for review, run `agentsquad task notify-done --task <task-id>`.",
    "If you are validating or reviewing work, run `agentsquad task update-status --status done` when it passes.",
    "If validation fails, run `agentsquad task update-status --status blocked --note \"...\"` with actionable feedback.",
  ].join("\n");
}

module.exports = {
  createHumanReadableAgentId,
  listAgents,
  resolveAgent,
  showAgent,
  showLogs,
  spawnAgent,
  stopAgent,
  persistAgent,
  persistSession,
};
