const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureWorkspace, ensureAgentWorkspace, getAgentsRoot, getDatabasePath, pathExists, readJsonFile, writeJsonFile } = require("./state");
const { createId } = require("./ids");
const { appendEvent } = require("./events");
const { AgentsquadError } = require("./errors");
const { ensureDatabase, getAll, getOne, runStatement } = require("./db");
const { buildAgentId, generateAgentName } = require("./agent-naming");
const { createTask } = require("./tasks");
const { resolveProvider, mergeProviderConfig } = require("../providers/adapter-registry");
const { startDetachedProcess, readPid, isPidAlive, stopPid } = require("./process-manager");

async function listAgents(cwd, sessionId = "default") {
  await ensureWorkspace(cwd, sessionId);
  await ensureDatabase(cwd);
  const persistedAgents = getAll(
    cwd,
    `SELECT
      id,
      name,
      role,
      kind,
      provider_id AS providerId,
      profile,
      session_id AS sessionId,
      goal,
      mode,
      workdir,
      created_at AS createdAt,
      updated_at AS updatedAt,
      status,
      current_task_id AS currentTaskId
    FROM agents
    WHERE session_id = ?
    ORDER BY created_at ASC`,
    [sessionId]
  );

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
  await ensureDatabase(cwd);
  runStatement(
    cwd,
    `INSERT INTO agents (
      id, session_id, name, role, kind, provider_id, profile, goal, status, mode, workdir,
      current_task_id, parent_agent_id, created_by_agent_id, system_prompt, launch_command,
      last_heartbeat_at, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      name = excluded.name,
      role = excluded.role,
      kind = excluded.kind,
      provider_id = excluded.provider_id,
      profile = excluded.profile,
      goal = excluded.goal,
      status = excluded.status,
      mode = excluded.mode,
      workdir = excluded.workdir,
      current_task_id = excluded.current_task_id,
      parent_agent_id = excluded.parent_agent_id,
      created_by_agent_id = excluded.created_by_agent_id,
      system_prompt = excluded.system_prompt,
      launch_command = excluded.launch_command,
      last_heartbeat_at = excluded.last_heartbeat_at,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at`,
    [
      agent.id,
      sessionId,
      agent.name || "worker",
      agent.role || "worker",
      agent.kind || "worker",
      agent.providerId,
      agent.profile || null,
      agent.goal || "Support the project goal",
      agent.status,
      agent.mode || "oneshot",
      agent.workdir,
      agent.currentTaskId || null,
      agent.parentAgentId || null,
      agent.createdByAgentId || null,
      agent.systemPrompt || null,
      agent.launchCommand || null,
      agent.lastHeartbeatAt || null,
      agent.createdAt,
      agent.updatedAt,
      agent.archivedAt || null,
    ]
  );
  return workspace;
}

async function spawnAgent(cwd, config, options) {
  const sessionId = options.session || config.defaultSession || "default";
  await ensureWorkspace(cwd, sessionId);
  await ensureDatabase(cwd);

  const providerConfig = mergeProviderConfig(config, options.provider, options.profile);
  const adapter = resolveProvider(options.provider);
  const now = new Date().toISOString();
  const workdir = path.resolve(options.workdir || cwd);
  const role = options.role || "worker";
  const name = options.name || generateAgentName(Date.now());
  const agentId = await createHumanReadableAgentId(cwd, sessionId, name, role);

  runStatement(
    cwd,
    `INSERT INTO sessions (id, title, goal, status, manager_agent_id, provider_id, root_workdir, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    [
      sessionId,
      sessionId,
      options.goal || `Session ${sessionId}`,
      "active",
      null,
      options.provider,
      workdir,
      now,
      now,
      null,
    ]
  );

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
  };
  agent.env.AGENTSQUAD_DB_PATH = getDatabasePath(cwd);

  const workspace = await persistAgent(cwd, sessionId, agent);
  const launchCommand = [providerConfig.command, ...(providerConfig.args || [])].join(" ");
  agent.launchCommand = launchCommand;
  await persistAgent(cwd, sessionId, agent);

  runStatement(
    cwd,
    `INSERT INTO agent_runs (
      id, agent_id, session_id, provider_id, command, args_json, pid, exit_code, exit_signal, status, stdout_path, stderr_path, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("run"),
      agent.id,
      sessionId,
      agent.providerId,
      providerConfig.command,
      JSON.stringify(providerConfig.args || []),
      null,
      null,
      null,
      providerConfig.mode === "detached" ? "starting" : "completed",
      workspace.stdoutPath,
      workspace.stderrPath,
      now,
      providerConfig.mode === "detached" ? null : now,
    ]
  );

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
  runStatement(cwd, "UPDATE agents SET status = ?, updated_at = ? WHERE id = ?", [next.status, next.updatedAt, next.id]);
  await appendEvent(cwd, sessionId, "agent.stopped", { pid: result.pid }, agent.id);

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
  await ensureDatabase(cwd);
  let index = 0;
  while (true) {
    const candidate = buildAgentId(name, role, index);
    const existing = getOne(cwd, "SELECT id FROM agents WHERE id = ? AND session_id = ?", [candidate, sessionId]);
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

module.exports = {
  createHumanReadableAgentId,
  listAgents,
  resolveAgent,
  showAgent,
  showLogs,
  spawnAgent,
  stopAgent,
};
