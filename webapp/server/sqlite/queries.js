import { ApiError } from "@/server/http/errors";
import { withReadOnlyDatabase } from "@/server/sqlite/connection";

function getSessionRecord(db, sessionId) {
  const session = db
    .prepare(
      `SELECT
        id,
        title,
        goal,
        status,
        manager_agent_id AS managerAgentId,
        provider_id AS providerId,
        root_workdir AS rootWorkdir,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM sessions
      WHERE id = ?`
    )
    .get(sessionId);

  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `No session found for "${sessionId}".`);
  }

  return session;
}

export async function listSessions(dbPath) {
  return withReadOnlyDatabase(dbPath, (db) =>
    db
      .prepare(
        `SELECT
          id,
          title,
          goal,
          status,
          manager_agent_id AS managerAgentId,
          provider_id AS providerId,
          root_workdir AS rootWorkdir,
          created_at AS createdAt,
          updated_at AS updatedAt,
          completed_at AS completedAt
        FROM sessions
        ORDER BY updated_at DESC, created_at DESC`
      )
      .all()
  );
}

function listAgentsForSession(db, sessionId) {
  return db
    .prepare(
      `SELECT
        a.id,
        a.session_id AS sessionId,
        a.name,
        a.role,
        a.kind,
        a.provider_id AS providerId,
        a.profile,
        a.goal,
        a.status,
        a.mode,
        a.workdir,
        a.current_task_id AS currentTaskId,
        current_task.title AS currentTaskTitle,
        current_task.status AS currentTaskStatus,
        a.parent_agent_id AS parentAgentId,
        a.created_by_agent_id AS createdByAgentId,
        a.last_heartbeat_at AS lastHeartbeatAt,
        a.created_at AS createdAt,
        a.updated_at AS updatedAt,
        a.archived_at AS archivedAt
      FROM agents a
      LEFT JOIN tasks current_task ON current_task.id = a.current_task_id
      WHERE a.session_id = ?
      ORDER BY a.created_at ASC, a.id ASC`
    )
    .all(sessionId);
}

function listTasksForSession(db, sessionId) {
  return db
    .prepare(
      `SELECT
        t.id,
        t.session_id AS sessionId,
        t.agent_id AS agentId,
        a.name AS agentName,
        a.role AS agentRole,
        t.parent_task_id AS parentTaskId,
        t.title,
        t.goal,
        t.description,
        t.status,
        t.priority,
        t.task_type AS taskType,
        t.scope_path AS scopePath,
        t.acceptance_criteria AS acceptanceCriteria,
        t.blocking_reason AS blockingReason,
        t.result_summary AS resultSummary,
        t.created_by_agent_id AS createdByAgentId,
        t.started_at AS startedAt,
        t.completed_at AS completedAt,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.session_id = ?
      ORDER BY t.created_at ASC, t.id ASC`
    )
    .all(sessionId);
}

function listMessagesForSession(db, sessionId, limit = 200) {
  return db
    .prepare(
      `SELECT
        m.id,
        m.session_id AS sessionId,
        m.thread_id AS threadId,
        m.from_type AS fromType,
        m.from_agent_id AS fromAgentId,
        from_agent.name AS fromAgentName,
        m.to_agent_id AS toAgentId,
        to_agent.name AS toAgentName,
        m.message_kind AS messageKind,
        m.text,
        m.delivery_status AS deliveryStatus,
        m.related_task_id AS relatedTaskId,
        related_task.title AS relatedTaskTitle,
        m.reply_to_message_id AS replyToMessageId,
        m.created_at AS createdAt,
        m.delivered_at AS deliveredAt,
        m.read_at AS readAt
      FROM messages m
      LEFT JOIN agents from_agent ON from_agent.id = m.from_agent_id
      LEFT JOIN agents to_agent ON to_agent.id = m.to_agent_id
      LEFT JOIN tasks related_task ON related_task.id = m.related_task_id
      WHERE m.session_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`
    )
    .all(sessionId, limit)
    .reverse();
}

function listLogsForSession(db, sessionId, limit = 200) {
  return db
    .prepare(
      `SELECT
        l.id,
        l.session_id AS sessionId,
        l.agent_id AS agentId,
        a.name AS agentName,
        l.level,
        l.kind,
        l.message,
        l.details_json AS detailsJson,
        l.created_at AS createdAt
      FROM activity_logs l
      LEFT JOIN agents a ON a.id = l.agent_id
      WHERE l.session_id = ?
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?`
    )
    .all(sessionId, limit)
    .reverse();
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

  if (!timestamps.length) {
    return null;
  }

  return timestamps.sort().at(-1);
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

export async function getSessionSnapshot(dbPath, sessionId, options = {}) {
  const messagesLimit = Number.isFinite(options.messagesLimit) ? options.messagesLimit : 200;
  const logsLimit = Number.isFinite(options.logsLimit) ? options.logsLimit : 200;

  return withReadOnlyDatabase(dbPath, (db) => {
    const session = getSessionRecord(db, sessionId);
    const agents = listAgentsForSession(db, sessionId);
    const tasks = listTasksForSession(db, sessionId);
    const messages = listMessagesForSession(db, sessionId, messagesLimit);
    const logs = listLogsForSession(db, sessionId, logsLimit);

    return {
      session,
      summary: computeSummary(session, agents, tasks, messages, logs),
      agents,
      tasks,
      messages,
      logs,
    };
  });
}

export async function getSessionChangeMarkers(dbPath, sessionId) {
  return withReadOnlyDatabase(dbPath, (db) => {
    getSessionRecord(db, sessionId);

    const sessionRow = db
      .prepare("SELECT updated_at AS updatedAt FROM sessions WHERE id = ?")
      .get(sessionId);
    const agentRow = db
      .prepare("SELECT MAX(updated_at) AS updatedAt FROM agents WHERE session_id = ?")
      .get(sessionId);
    const taskRow = db
      .prepare("SELECT MAX(updated_at) AS updatedAt FROM tasks WHERE session_id = ?")
      .get(sessionId);
    const messageRow = db
      .prepare("SELECT created_at AS createdAt, id FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionId);
    const logRow = db
      .prepare("SELECT created_at AS createdAt, id FROM activity_logs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionId);

    return {
      sessionUpdatedAt: sessionRow?.updatedAt || null,
      agentsUpdatedAt: agentRow?.updatedAt || null,
      tasksUpdatedAt: taskRow?.updatedAt || null,
      lastMessageCreatedAt: messageRow?.createdAt || null,
      lastMessageId: messageRow?.id || null,
      lastLogCreatedAt: logRow?.createdAt || null,
      lastLogId: logRow?.id || null,
    };
  });
}

export async function listMessagesSince(dbPath, sessionId, cursor, limit = 200) {
  return withReadOnlyDatabase(dbPath, (db) => {
    getSessionRecord(db, sessionId);

    return db
      .prepare(
        `SELECT
          m.id,
          m.session_id AS sessionId,
          m.thread_id AS threadId,
          m.from_type AS fromType,
          m.from_agent_id AS fromAgentId,
          from_agent.name AS fromAgentName,
          m.to_agent_id AS toAgentId,
          to_agent.name AS toAgentName,
          m.message_kind AS messageKind,
          m.text,
          m.delivery_status AS deliveryStatus,
          m.related_task_id AS relatedTaskId,
          related_task.title AS relatedTaskTitle,
          m.reply_to_message_id AS replyToMessageId,
          m.created_at AS createdAt,
          m.delivered_at AS deliveredAt,
          m.read_at AS readAt
        FROM messages m
        LEFT JOIN agents from_agent ON from_agent.id = m.from_agent_id
        LEFT JOIN agents to_agent ON to_agent.id = m.to_agent_id
        LEFT JOIN tasks related_task ON related_task.id = m.related_task_id
        WHERE m.session_id = ?
          AND (
            m.created_at > ?
            OR (m.created_at = ? AND m.id > ?)
          )
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`
      )
      .all(sessionId, cursor.createdAt || "", cursor.createdAt || "", cursor.id || "", limit);
  });
}

export async function listLogsSince(dbPath, sessionId, cursor, limit = 200) {
  return withReadOnlyDatabase(dbPath, (db) => {
    getSessionRecord(db, sessionId);

    return db
      .prepare(
        `SELECT
          l.id,
          l.session_id AS sessionId,
          l.agent_id AS agentId,
          a.name AS agentName,
          l.level,
          l.kind,
          l.message,
          l.details_json AS detailsJson,
          l.created_at AS createdAt
        FROM activity_logs l
        LEFT JOIN agents a ON a.id = l.agent_id
        WHERE l.session_id = ?
          AND (
            l.created_at > ?
            OR (l.created_at = ? AND l.id > ?)
          )
        ORDER BY l.created_at ASC, l.id ASC
        LIMIT ?`
      )
      .all(sessionId, cursor.createdAt || "", cursor.createdAt || "", cursor.id || "", limit);
  });
}

export async function listAgents(dbPath, sessionId) {
  return withReadOnlyDatabase(dbPath, (db) => {
    getSessionRecord(db, sessionId);
    return listAgentsForSession(db, sessionId);
  });
}

export async function listTasks(dbPath, sessionId) {
  return withReadOnlyDatabase(dbPath, (db) => {
    getSessionRecord(db, sessionId);
    return listTasksForSession(db, sessionId);
  });
}

export async function getSessionSummary(dbPath, sessionId, options = {}) {
  const snapshot = await getSessionSnapshot(dbPath, sessionId, options);
  return {
    session: snapshot.session,
    summary: snapshot.summary,
  };
}
