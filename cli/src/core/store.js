const { appendJsonl, readJsonl } = require("../utils/jsonl");
const {
  ensureWorkspace,
  getSessionsRoot,
  getSessionRoot,
  getSessionStatePath,
  getAgentsIndexPath,
  getTasksPath,
  getTaskDependenciesPath,
  getTaskStatusHistoryPath,
  getMessagesPath,
  getActivityLogsPath,
  getAgentRunsPath,
  getArtifactsPath,
  pathExists,
} = require("./state");

const SNAPSHOT_FILES = {
  session: getSessionStatePath,
  agents: getAgentsIndexPath,
  tasks: getTasksPath,
  messages: getMessagesPath,
  agentRuns: getAgentRunsPath,
  artifacts: getArtifactsPath,
};

const APPEND_ONLY_FILES = {
  taskDependencies: getTaskDependenciesPath,
  taskStatusHistory: getTaskStatusHistoryPath,
  activityLogs: getActivityLogsPath,
};

async function ensureSessionStore(cwd, sessionId = "default") {
  await ensureWorkspace(cwd, sessionId);
  const paths = [
    getSessionStatePath(cwd, sessionId),
    getAgentsIndexPath(cwd, sessionId),
    getTasksPath(cwd, sessionId),
    getTaskDependenciesPath(cwd, sessionId),
    getTaskStatusHistoryPath(cwd, sessionId),
    getMessagesPath(cwd, sessionId),
    getActivityLogsPath(cwd, sessionId),
    getAgentRunsPath(cwd, sessionId),
    getArtifactsPath(cwd, sessionId),
  ];

  await Promise.all(paths.map(async (filePath) => {
    if (!(await pathExists(filePath))) {
      await appendJsonl(filePath, { __init: true, timestamp: new Date(0).toISOString() });
    }
  }));
}

async function appendSnapshot(cwd, sessionId, fileType, value) {
  await ensureSessionStore(cwd, sessionId);
  await appendJsonl(SNAPSHOT_FILES[fileType](cwd, sessionId), value);
  return value;
}

async function appendRecord(cwd, sessionId, fileType, value) {
  await ensureSessionStore(cwd, sessionId);
  await appendJsonl(APPEND_ONLY_FILES[fileType](cwd, sessionId), value);
  return value;
}

async function readSnapshots(cwd, sessionId, fileType) {
  await ensureSessionStore(cwd, sessionId);
  const rows = await readJsonl(SNAPSHOT_FILES[fileType](cwd, sessionId));
  return projectLatestById(rows);
}

async function readRecords(cwd, sessionId, fileType) {
  await ensureSessionStore(cwd, sessionId);
  const rows = await readJsonl(APPEND_ONLY_FILES[fileType](cwd, sessionId));
  return rows.filter((entry) => !entry.__init);
}

async function readSession(cwd, sessionId) {
  const rows = await readSnapshots(cwd, sessionId, "session");
  return rows.at(-1) || null;
}

async function listSessions(cwd) {
  await ensureWorkspace(cwd);
  const sessionsRoot = getSessionsRoot(cwd);
  let entries = [];
  try {
    entries = await require("node:fs/promises").readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const session = await readSession(cwd, entry.name);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => {
    const left = a.updatedAt || a.createdAt || "";
    const right = b.updatedAt || b.createdAt || "";
    return right.localeCompare(left);
  });
}

function projectLatestById(rows) {
  const byId = new Map();
  const ordered = [];

  for (const row of rows) {
    if (!row || row.__init) {
      continue;
    }

    if (!row.id) {
      ordered.push(row);
      continue;
    }

    byId.set(row.id, row);
  }

  return [...ordered, ...byId.values()];
}

module.exports = {
  appendRecord,
  appendSnapshot,
  ensureSessionStore,
  listSessions,
  projectLatestById,
  readRecords,
  readSession,
  readSnapshots,
};
