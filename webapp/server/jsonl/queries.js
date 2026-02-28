import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/server/http/errors";
import { readJsonl } from "@/server/jsonl/connection";

function projectLatestById(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row?.id) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

function getSessionRoot(workspacePath, sessionId) {
  return path.join(workspacePath, "sessions", sessionId);
}

async function readSessionRows(workspacePath, sessionId, fileName) {
  return readJsonl(path.join(getSessionRoot(workspacePath, sessionId), fileName));
}

async function getSessionRecord(workspacePath, sessionId) {
  const rows = await readSessionRows(workspacePath, sessionId, "session.jsonl");
  const session = rows.at(-1) || null;
  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `No session found for "${sessionId}".`);
  }
  return session;
}

export async function listSessions(workspacePath) {
  const sessionsRoot = path.join(workspacePath, "sessions");
  let entries = [];
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rows = await readSessionRows(workspacePath, entry.name, "session.jsonl");
    const session = rows.at(-1);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => `${b.updatedAt || ""}${b.createdAt || ""}`.localeCompare(`${a.updatedAt || ""}${a.createdAt || ""}`));
}

async function listAgentsForSession(workspacePath, sessionId) {
  const [agents, tasks] = await Promise.all([
    readSessionRows(workspacePath, sessionId, "agents.jsonl").then(projectLatestById),
    readSessionRows(workspacePath, sessionId, "tasks.jsonl").then(projectLatestById),
  ]);

  return agents
    .map((agent) => {
      const currentTask = tasks.find((task) => task.id === agent.currentTaskId) || null;
      return {
        ...agent,
        currentTaskTitle: currentTask?.title || null,
        currentTaskStatus: currentTask?.status || null,
      };
    })
    .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`));
}

async function listTasksForSession(workspacePath, sessionId) {
  const [tasks, agents] = await Promise.all([
    readSessionRows(workspacePath, sessionId, "tasks.jsonl").then(projectLatestById),
    readSessionRows(workspacePath, sessionId, "agents.jsonl").then(projectLatestById),
  ]);

  return tasks
    .map((task) => {
      const agent = agents.find((entry) => entry.id === task.agentId) || null;
      return {
        ...task,
        agentName: agent?.name || null,
        agentRole: agent?.role || null,
      };
    })
    .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`));
}

async function listMessagesForSession(workspacePath, sessionId, limit = 200) {
  const [messages, agents, tasks] = await Promise.all([
    readSessionRows(workspacePath, sessionId, "messages.jsonl").then(projectLatestById),
    readSessionRows(workspacePath, sessionId, "agents.jsonl").then(projectLatestById),
    readSessionRows(workspacePath, sessionId, "tasks.jsonl").then(projectLatestById),
  ]);

  return messages
    .map((message) => ({
      ...message,
      fromAgentId: message.from || null,
      fromAgentName: agents.find((entry) => entry.id === message.from)?.name || null,
      toAgentId: message.to || null,
      toAgentName: agents.find((entry) => entry.id === message.to)?.name || null,
      relatedTaskTitle: tasks.find((entry) => entry.id === message.relatedTaskId)?.title || null,
    }))
    .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`))
    .slice(-limit);
}

async function listLogsForSession(workspacePath, sessionId, limit = 200) {
  const [logs, agents] = await Promise.all([
    readSessionRows(workspacePath, sessionId, "activity-logs.jsonl"),
    readSessionRows(workspacePath, sessionId, "agents.jsonl").then(projectLatestById),
  ]);

  return logs
    .map((entry) => ({
      ...entry,
      agentName: agents.find((agent) => agent.id === entry.agentId)?.name || null,
    }))
    .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`))
    .slice(-limit);
}

function countTasksByStatus(tasks) {
  return tasks.reduce((accumulator, task) => {
    accumulator[task.status] = (accumulator[task.status] || 0) + 1;
    return accumulator;
  }, {});
}

function computeLastActivityAt({ session, agents, tasks, messages, logs }) {
  const timestamps = [
    session.updatedAt,
    ...agents.map((entry) => entry.updatedAt),
    ...tasks.map((entry) => entry.updatedAt),
    ...messages.map((entry) => entry.createdAt),
    ...logs.map((entry) => entry.createdAt),
  ].filter(Boolean);

  return timestamps.length ? timestamps.sort().at(-1) : null;
}

function computeSummary(session, agents, tasks, messages, logs) {
  return {
    agentCount: agents.length,
    messageCount: messages.length,
    logCount: logs.length,
    tasksByStatus: countTasksByStatus(tasks),
    lastActivityAt: computeLastActivityAt({ session, agents, tasks, messages, logs }),
  };
}

export async function getSessionSnapshot(workspacePath, sessionId, options = {}) {
  const messagesLimit = Number.isFinite(options.messagesLimit) ? options.messagesLimit : 200;
  const logsLimit = Number.isFinite(options.logsLimit) ? options.logsLimit : 200;
  const session = await getSessionRecord(workspacePath, sessionId);
  const [agents, tasks, messages, logs] = await Promise.all([
    listAgentsForSession(workspacePath, sessionId),
    listTasksForSession(workspacePath, sessionId),
    listMessagesForSession(workspacePath, sessionId, messagesLimit),
    listLogsForSession(workspacePath, sessionId, logsLimit),
  ]);

  return {
    session,
    summary: computeSummary(session, agents, tasks, messages, logs),
    agents,
    tasks,
    messages,
    logs,
  };
}

export async function getSessionChangeMarkers(workspacePath, sessionId) {
  const snapshot = await getSessionSnapshot(workspacePath, sessionId);
  const lastMessage = snapshot.messages.at(-1) || null;
  const lastLog = snapshot.logs.at(-1) || null;

  return {
    sessionUpdatedAt: snapshot.session.updatedAt || null,
    agentsUpdatedAt: snapshot.agents.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1) || null,
    tasksUpdatedAt: snapshot.tasks.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1) || null,
    lastMessageCreatedAt: lastMessage?.createdAt || null,
    lastMessageId: lastMessage?.id || null,
    lastLogCreatedAt: lastLog?.createdAt || null,
    lastLogId: lastLog?.id || null,
  };
}

export async function listMessagesSince(workspacePath, sessionId, cursor, limit = 200) {
  const rows = await listMessagesForSession(workspacePath, sessionId, Number.MAX_SAFE_INTEGER);
  return rows
    .filter((message) => message.createdAt > (cursor.createdAt || "")
      || (message.createdAt === (cursor.createdAt || "") && message.id > (cursor.id || "")))
    .slice(0, limit);
}

export async function listLogsSince(workspacePath, sessionId, cursor, limit = 200) {
  const rows = await listLogsForSession(workspacePath, sessionId, Number.MAX_SAFE_INTEGER);
  return rows
    .filter((entry) => entry.createdAt > (cursor.createdAt || "")
      || (entry.createdAt === (cursor.createdAt || "") && entry.id > (cursor.id || "")))
    .slice(0, limit);
}

export async function listAgents(workspacePath, sessionId) {
  await getSessionRecord(workspacePath, sessionId);
  return listAgentsForSession(workspacePath, sessionId);
}

export async function listTasks(workspacePath, sessionId) {
  await getSessionRecord(workspacePath, sessionId);
  return listTasksForSession(workspacePath, sessionId);
}

export async function getSessionSummary(workspacePath, sessionId, options = {}) {
  const snapshot = await getSessionSnapshot(workspacePath, sessionId, options);
  return {
    session: snapshot.session,
    summary: snapshot.summary,
  };
}
