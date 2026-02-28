const { createId } = require("./ids");
const { ensureDatabase, getAll, getOne, runStatement } = require("./db");
const { appendEvent } = require("./events");
const { AgentsquadError } = require("./errors");

function resolveAgentIdentity(options = {}) {
  return options.agent || process.env.AGENTSQUAD_AGENT_ID || null;
}

function resolveSessionIdentity(options = {}) {
  return options.session || process.env.AGENTSQUAD_SESSION_ID || "default";
}

async function createTask(cwd, input) {
  await ensureDatabase(cwd);
  const now = new Date().toISOString();
  const task = {
    id: input.id || createId("task"),
    sessionId: input.sessionId,
    agentId: input.agentId,
    parentTaskId: input.parentTaskId || null,
    title: input.title || input.task || "Assigned task",
    goal: input.goal || "Support the project objective",
    description: input.description || input.task || input.title || "No task description provided.",
    status: input.status || "todo",
    priority: input.priority || "medium",
    taskType: input.taskType || "other",
    scopePath: input.scopePath || null,
    acceptanceCriteria: input.acceptanceCriteria || null,
    blockingReason: input.blockingReason || null,
    resultSummary: input.resultSummary || null,
    createdByAgentId: input.createdByAgentId || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    createdAt: now,
    updatedAt: now,
  };

  runStatement(
    cwd,
    `INSERT INTO tasks (
      id, session_id, agent_id, parent_task_id, title, goal, description, status,
      priority, task_type, scope_path, acceptance_criteria, blocking_reason,
      result_summary, created_by_agent_id, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.sessionId,
      task.agentId,
      task.parentTaskId,
      task.title,
      task.goal,
      task.description,
      task.status,
      task.priority,
      task.taskType,
      task.scopePath,
      task.acceptanceCriteria,
      task.blockingReason,
      task.resultSummary,
      task.createdByAgentId,
      task.startedAt,
      task.completedAt,
      task.createdAt,
      task.updatedAt,
    ]
  );

  runStatement(
    cwd,
    "INSERT INTO task_status_history (id, session_id, task_id, from_status, to_status, changed_by_agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [createId("taskstatus"), task.sessionId, task.id, null, task.status, task.createdByAgentId, "Task created", now]
  );

  runStatement(cwd, "UPDATE agents SET current_task_id = ?, updated_at = ? WHERE id = ?", [task.id, now, task.agentId]);
  await appendEvent(cwd, task.sessionId, "task.assigned", { taskId: task.id, status: task.status }, task.agentId);

  return getTaskById(cwd, task.id);
}

function getTaskById(cwd, taskId) {
  return getOne(
    cwd,
    `SELECT
      t.id,
      t.session_id AS sessionId,
      t.agent_id AS agentId,
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
    WHERE t.id = ?`,
    [taskId]
  );
}

function getCurrentTask(cwd, sessionId, agentId) {
  const task = getOne(
    cwd,
    `SELECT
      t.id,
      t.session_id AS sessionId,
      t.agent_id AS agentId,
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
      t.created_at AS createdAt,
      t.updated_at AS updatedAt
    FROM tasks t
    WHERE t.session_id = ? AND t.agent_id = ?
    ORDER BY CASE t.status
      WHEN 'in_progress' THEN 0
      WHEN 'ready' THEN 1
      WHEN 'todo' THEN 2
      WHEN 'waiting' THEN 3
      WHEN 'blocked' THEN 4
      ELSE 5
    END, t.created_at DESC
    LIMIT 1`,
    [sessionId, agentId]
  );

  if (!task) {
    return null;
  }

  const availableAgents = getAll(
    cwd,
    `SELECT
      a.id,
      a.name,
      a.role,
      a.status,
      t.title AS taskTitle,
      t.status AS taskStatus
    FROM agents a
    LEFT JOIN tasks t ON t.id = a.current_task_id
    WHERE a.session_id = ? AND a.id != ?
    ORDER BY a.role ASC, a.id ASC`,
    [sessionId, agentId]
  );

  return {
    ...task,
    availableAgents,
  };
}

async function getTaskContext(cwd, options = {}) {
  await ensureDatabase(cwd);
  const agentId = resolveAgentIdentity(options);
  const sessionId = resolveSessionIdentity(options);
  if (!agentId) {
    throw new AgentsquadError("AGENT_ID_REQUIRED", "Unable to resolve the current agent. Provide --agent or set AGENTSQUAD_AGENT_ID.");
  }

  const agent = getOne(
    cwd,
    `SELECT
      id,
      session_id AS sessionId,
      name,
      role,
      goal,
      status,
      current_task_id AS currentTaskId,
      workdir
    FROM agents
    WHERE id = ? AND session_id = ?`,
    [agentId, sessionId]
  );

  if (!agent) {
    throw new AgentsquadError("AGENT_NOT_FOUND", `No agent found for "${agentId}" in session "${sessionId}".`);
  }

  return {
    agent,
    task: getCurrentTask(cwd, sessionId, agentId),
  };
}

async function listTasks(cwd, options = {}) {
  await ensureDatabase(cwd);
  const sessionId = resolveSessionIdentity(options);
  const params = [sessionId];
  let sql = `
    SELECT
      t.id,
      t.session_id AS sessionId,
      t.agent_id AS agentId,
      a.role AS agentRole,
      t.title,
      t.goal,
      t.description,
      t.status,
      t.priority,
      t.task_type AS taskType,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE t.session_id = ?`;

  if (options.agent) {
    sql += " AND t.agent_id = ?";
    params.push(options.agent);
  }

  sql += " ORDER BY t.created_at ASC";
  return getAll(cwd, sql, params);
}

async function assignTask(cwd, options = {}) {
  return createTask(cwd, {
    sessionId: resolveSessionIdentity(options),
    agentId: options.agent,
    title: options.title || options.task,
    goal: options.goal,
    description: options.task,
    status: options.status || "todo",
    priority: options.priority || "medium",
    taskType: options.type || "other",
    acceptanceCriteria: options.acceptanceCriteria || null,
    createdByAgentId: resolveAgentIdentity(options),
  });
}

async function updateTaskStatus(cwd, options = {}) {
  await ensureDatabase(cwd);
  const task = getTaskById(cwd, options.task);
  if (!task) {
    throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${options.task}".`);
  }

  const now = new Date().toISOString();
  const nextStatus = options.status;
  const startedAt = nextStatus === "in_progress" && !task.startedAt ? now : task.startedAt;
  const completedAt = nextStatus === "done" ? now : null;

  runStatement(
    cwd,
    `UPDATE tasks
      SET status = ?, blocking_reason = ?, result_summary = ?, started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`,
    [nextStatus, options.blockingReason || null, options.resultSummary || null, startedAt, completedAt, now, task.id]
  );

  runStatement(
    cwd,
    "INSERT INTO task_status_history (id, session_id, task_id, from_status, to_status, changed_by_agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [createId("taskstatus"), task.sessionId, task.id, task.status, nextStatus, resolveAgentIdentity(options), options.note || null, now]
  );

  await appendEvent(cwd, task.sessionId, "task.status_changed", { taskId: task.id, from: task.status, to: nextStatus }, task.agentId);
  return getTaskById(cwd, task.id);
}

module.exports = {
  assignTask,
  createTask,
  getCurrentTask,
  getTaskById,
  getTaskContext,
  listTasks,
  resolveAgentIdentity,
  resolveSessionIdentity,
  updateTaskStatus,
};
