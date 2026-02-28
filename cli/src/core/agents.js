const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureWorkspace, ensureAgentWorkspace, getAgentsRoot, pathExists, readJsonFile, writeJsonFile } = require("./state");
const { createId } = require("./ids");
const { appendEvent } = require("./events");
const { AgentsquadError } = require("./errors");
const { resolveProvider, mergeProviderConfig } = require("../providers/adapter-registry");
const { startDetachedProcess, readPid, isPidAlive, stopPid } = require("./process-manager");

async function listAgents(cwd, sessionId = "default") {
  await ensureWorkspace(cwd, sessionId);
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
  return workspace;
}

async function spawnAgent(cwd, config, options) {
  const sessionId = options.session || config.defaultSession || "default";
  await ensureWorkspace(cwd, sessionId);

  const providerConfig = mergeProviderConfig(config, options.provider, options.profile);
  const adapter = resolveProvider(options.provider);
  const agentId = createId("agent");
  const now = new Date().toISOString();
  const workdir = path.resolve(options.workdir || cwd);

  const agent = {
    id: agentId,
    name: options.name || null,
    providerId: options.provider,
    profile: options.profile || null,
    sessionId,
    workdir,
    createdAt: now,
    updatedAt: now,
    status: providerConfig.mode === "detached" ? "starting" : "idle",
    mode: providerConfig.mode || "oneshot",
    env: normalizeEnv(options.env),
  };

  const workspace = await persistAgent(cwd, sessionId, agent);

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

  await appendEvent(cwd, sessionId, "agent.spawned", {
    providerId: agent.providerId,
    workdir: agent.workdir,
    mode: agent.mode,
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

module.exports = {
  listAgents,
  resolveAgent,
  showAgent,
  showLogs,
  spawnAgent,
  stopAgent,
};
