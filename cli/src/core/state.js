const fs = require("node:fs/promises");
const path = require("node:path");

const WORKSPACE_DIR = ".agentsquad";

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value || "");
}

function resolveExternalPath(value) {
  if (!value) {
    return value;
  }

  if (isWindowsAbsolutePath(value) || path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(value);
}

function getWorkspaceRoot(cwd) {
  const explicitRoot = process.env.AGENTSQUAD_WORKSPACE_ROOT;
  if (explicitRoot) {
    return resolveExternalPath(explicitRoot);
  }

  const explicitDbPath = process.env.AGENTSQUAD_DB_PATH;
  if (explicitDbPath) {
    const resolvedDbPath = resolveExternalPath(explicitDbPath);
    return isWindowsAbsolutePath(resolvedDbPath) ? path.win32.dirname(resolvedDbPath) : path.dirname(resolvedDbPath);
  }

  return path.join(cwd, WORKSPACE_DIR);
}

function getSessionsRoot(cwd) {
  return path.join(getWorkspaceRoot(cwd), "sessions");
}

function getSessionRoot(cwd, sessionId) {
  return path.join(getSessionsRoot(cwd), sessionId);
}

function getAgentsRoot(cwd, sessionId) {
  return path.join(getSessionRoot(cwd, sessionId), "agents");
}

function getAgentRoot(cwd, sessionId, agentId) {
  return path.join(getAgentsRoot(cwd, sessionId), agentId);
}

function getDatabasePath(cwd) {
  return path.join(getWorkspaceRoot(cwd), "agentsquad.db");
}

async function ensureWorkspace(cwd, sessionId = "default") {
  const root = getWorkspaceRoot(cwd);
  const sessionRoot = getSessionRoot(cwd, sessionId);
  const agentsRoot = getAgentsRoot(cwd, sessionId);

  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(getSessionsRoot(cwd), { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.mkdir(agentsRoot, { recursive: true });

  return {
    root,
    sessionRoot,
    agentsRoot,
  };
}

async function ensureAgentWorkspace(cwd, sessionId, agentId) {
  const agentRoot = getAgentRoot(cwd, sessionId, agentId);
  await fs.mkdir(agentRoot, { recursive: true });
  return {
    root: agentRoot,
    stdoutPath: path.join(agentRoot, "stdout.log"),
    stderrPath: path.join(agentRoot, "stderr.log"),
    inboxPath: path.join(agentRoot, "inbox.jsonl"),
    outboxPath: path.join(agentRoot, "outbox.jsonl"),
    eventsPath: path.join(agentRoot, "events.jsonl"),
    agentPath: path.join(agentRoot, "agent.json"),
    pidPath: path.join(agentRoot, "pid.json"),
  };
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  WORKSPACE_DIR,
  ensureWorkspace,
  ensureAgentWorkspace,
  getDatabasePath,
  getWorkspaceRoot,
  getSessionRoot,
  getSessionsRoot,
  getAgentsRoot,
  getAgentRoot,
  readJsonFile,
  writeJsonFile,
  pathExists,
};
