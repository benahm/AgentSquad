const { createId } = require("./ids");
const { ensureDatabase, getAll, getOne, runStatement } = require("./db");
const { appendEvent } = require("./events");
const { appendActivityLog } = require("./activity-logs");
const { AgentsquadError } = require("./errors");

const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "cancelled"]);
const DEPENDENCY_SATISFIED_STATUSES = new Set(["done"]);
const VALIDATOR_TASK_TYPES = new Set(["testing", "review"]);
const DEFAULT_POLL_INTERVAL_MS = 1500;

function resolveAgentIdentity(options = {}) {
  return options.agent || process.env.AGENTSQUAD_AGENT_ID || null;
}

function resolveSessionIdentity(options = {}) {
  return options.session || process.env.AGENTSQUAD_SESSION_ID || "default";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isDependencySatisfiedForTask(taskType, dependencyStatus) {
  if (DEPENDENCY_SATISFIED_STATUSES.has(dependencyStatus)) {
    return true;
  }

  if (VALIDATOR_TASK_TYPES.has(taskType) && dependencyStatus === "in_review") {
    return true;
  }

  return false;
}

function normalizeDependencyDefinitions(input) {
  const dependencies = Array.isArray(input) ? input : input ? [input] : [];
  return dependencies
    .filter(Boolean)
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          dependsOnTaskId: entry,
          dependencyType: "blocks",
        };
      }

      return {
        dependsOnTaskId: entry.dependsOnTaskId || entry.taskId || entry.dependsOn || entry.id,
        dependencyType: entry.dependencyType || entry.type || "blocks",
      };
    })
    .filter((entry) => entry.dependsOnTaskId);
}

function computeWaitMode(options = {}) {
  if (options.wait === true) {
    return true;
  }

  if (options.noWait === true) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(options, "wait")) {
    return Boolean(options.wait);
  }

  return !options.agent && Boolean(process.env.AGENTSQUAD_AGENT_ID);
}

function resolvePollInterval(options = {}) {
  const value = Number(options.pollIntervalMs || options.pollInterval || DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(100, Math.floor(value));
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

  const dependencies = normalizeDependencyDefinitions(input.dependencies);
  if (dependencies.length) {
    await createTaskDependencies(cwd, task.sessionId, task.id, dependencies, {
      changedByAgentId: task.createdByAgentId,
    });
  }

  runStatement(cwd, "UPDATE agents SET current_task_id = ?, updated_at = ? WHERE id = ?", [task.id, now, task.agentId]);
  await appendEvent(cwd, task.sessionId, "task.assigned", { taskId: task.id, status: task.status }, task.agentId);
  await appendActivityLog(cwd, {
    sessionId: task.sessionId,
    agentId: task.agentId,
    kind: "task.assignment",
    message: `${task.agentId} assigned: ${task.title}`,
    details: {
      status: task.status,
      priority: task.priority,
      dependencies: dependencies.map((entry) => entry.dependsOnTaskId),
    },
    reporter: input.reporter,
  });

  await promoteTaskToReadyIfUnblocked(cwd, task.id, {
    changedByAgentId: task.createdByAgentId,
  });

  return getTaskById(cwd, task.id);
}

async function createTaskDependencies(cwd, sessionId, taskId, dependencies, options = {}) {
  await ensureDatabase(cwd);
  const normalized = normalizeDependencyDefinitions(dependencies);
  if (!normalized.length) {
    return [];
  }

  const now = new Date().toISOString();
  for (const entry of normalized) {
    runStatement(
      cwd,
      `INSERT OR IGNORE INTO task_dependencies (
        id, session_id, task_id, depends_on_task_id, dependency_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [createId("taskdep"), sessionId, taskId, entry.dependsOnTaskId, entry.dependencyType, now]
    );
  }

  await appendEvent(cwd, sessionId, "task.dependencies_created", {
    taskId,
    dependencies: normalized.map((entry) => ({
      dependsOnTaskId: entry.dependsOnTaskId,
      dependencyType: entry.dependencyType,
    })),
  }, options.changedByAgentId || null);

  await appendActivityLog(cwd, {
    sessionId,
    agentId: options.changedByAgentId || null,
    kind: "task.dependencies",
    message: `${taskId} dependencies updated`,
    details: {
      taskId,
      dependencies: normalized,
    },
  });

  return listTaskDependencies(cwd, taskId);
}

function getTaskById(cwd, taskId) {
  const task = getOne(
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

  return task ? hydrateTask(cwd, task) : null;
}

function hydrateTask(cwd, task) {
  const dependencies = listTaskDependencies(cwd, task.id);
  const blockingTasks = dependencies.filter((entry) => {
    if (entry.dependencyType !== "blocks") {
      return false;
    }

    return !isDependencySatisfiedForTask(task.taskType, entry.dependsOnTaskStatus);
  });
  const waitState = blockingTasks.length ? "waiting_for_dependencies" : "ready";

  return {
    ...task,
    dependencies,
    blockingTasks,
    waitState,
  };
}

function listTaskDependencies(cwd, taskId) {
  return getAll(
    cwd,
    `SELECT
      td.id,
      td.task_id AS taskId,
      td.depends_on_task_id AS dependsOnTaskId,
      td.dependency_type AS dependencyType,
      td.created_at AS createdAt,
      t.title AS dependsOnTaskTitle,
      t.status AS dependsOnTaskStatus,
      t.task_type AS dependsOnTaskType,
      t.agent_id AS dependsOnAgentId
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_task_id
    WHERE td.task_id = ?
    ORDER BY td.created_at ASC`,
    [taskId]
  );
}

function listBlockingDependencies(cwd, taskId) {
  const task = getOne(cwd, "SELECT task_type AS taskType FROM tasks WHERE id = ?", [taskId]);
  if (!task) {
    return [];
  }

  return listTaskDependencies(cwd, taskId).filter((entry) => {
    if (entry.dependencyType !== "blocks") {
      return false;
    }

    return !isDependencySatisfiedForTask(task.taskType, entry.dependsOnTaskStatus);
  });
}

function listDependentTasks(cwd, taskId, options = {}) {
  const onlyBlocking = options.onlyBlocking !== false;
  const filterValidatorTypes = options.onlyValidatorTypes === true;
  const params = [taskId];
  let sql = `
    SELECT
      td.id,
      td.task_id AS taskId,
      td.depends_on_task_id AS dependsOnTaskId,
      td.dependency_type AS dependencyType,
      td.created_at AS createdAt,
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
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.task_id
    WHERE td.depends_on_task_id = ?`;

  if (onlyBlocking) {
    sql += " AND td.dependency_type = 'blocks'";
  }

  if (filterValidatorTypes) {
    sql += " AND t.task_type IN ('testing', 'review')";
  }

  sql += " ORDER BY t.created_at ASC";

  return getAll(cwd, sql, params).map((task) => hydrateTask(cwd, task));
}

function hasUnresolvedBlockingDependencies(cwd, taskId) {
  return listBlockingDependencies(cwd, taskId).length > 0;
}

async function recordTaskStatusChange(cwd, task, nextStatus, options = {}) {
  const now = new Date().toISOString();
  const startedAt = nextStatus === "in_progress" && !task.startedAt ? now : task.startedAt;
  const completedAt = nextStatus === "done" ? now : TERMINAL_TASK_STATUSES.has(nextStatus) ? task.completedAt || now : null;

  runStatement(
    cwd,
    `UPDATE tasks
      SET status = ?, blocking_reason = ?, result_summary = ?, started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      nextStatus,
      options.blockingReason !== undefined ? options.blockingReason : task.blockingReason || null,
      options.resultSummary !== undefined ? options.resultSummary : task.resultSummary || null,
      startedAt,
      completedAt,
      now,
      task.id,
    ]
  );

  runStatement(
    cwd,
    "INSERT INTO task_status_history (id, session_id, task_id, from_status, to_status, changed_by_agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [createId("taskstatus"), task.sessionId, task.id, task.status, nextStatus, options.changedByAgentId || null, options.note || null, now]
  );

  await appendEvent(cwd, task.sessionId, "task.status_changed", { taskId: task.id, from: task.status, to: nextStatus }, task.agentId);
  await appendActivityLog(cwd, {
    sessionId: task.sessionId,
    agentId: task.agentId,
    kind: "task.status",
    message: `${task.agentId} status: ${task.status} -> ${nextStatus}`,
    details: {
      taskId: task.id,
      note: options.note || null,
    },
  });

  return getTaskById(cwd, task.id);
}

async function promoteTaskToReadyIfUnblocked(cwd, taskId, options = {}) {
  const task = getTaskById(cwd, taskId);
  if (!task || TERMINAL_TASK_STATUSES.has(task.status) || task.status === "in_review" || task.status === "in_progress") {
    return task;
  }

  if (hasUnresolvedBlockingDependencies(cwd, taskId)) {
    if (task.status !== "waiting") {
      return recordTaskStatusChange(cwd, task, "waiting", {
        changedByAgentId: options.changedByAgentId || null,
        note: options.note || "Waiting for dependencies",
        blockingReason: options.blockingReason !== undefined ? options.blockingReason : task.blockingReason,
      });
    }

    return task;
  }

  if (task.status === "todo" || task.status === "waiting") {
    const next = await recordTaskStatusChange(cwd, task, "ready", {
      changedByAgentId: options.changedByAgentId || null,
      note: options.note || "Dependencies satisfied",
      blockingReason: null,
    });

    await appendEvent(cwd, task.sessionId, "task.unblocked", { taskId: task.id }, task.agentId);
    return next;
  }

  return task;
}

async function refreshDependentTasks(cwd, taskId, options = {}) {
  const dependents = listDependentTasks(cwd, taskId, { onlyBlocking: true });
  const refreshed = [];
  for (const dependent of dependents) {
    refreshed.push(await promoteTaskToReadyIfUnblocked(cwd, dependent.id, options));
  }

  return refreshed;
}

async function reopenUpstreamTasksFromFeedback(cwd, feedbackTask, options = {}) {
  const dependencies = listTaskDependencies(cwd, feedbackTask.id).filter((entry) => entry.dependencyType === "blocks");
  const reopened = [];
  const feedback = options.note || options.resultSummary || feedbackTask.resultSummary || feedbackTask.blockingReason || "Changes requested by downstream validation.";

  for (const dependency of dependencies) {
    const upstream = getTaskById(cwd, dependency.dependsOnTaskId);
    if (!upstream || TERMINAL_TASK_STATUSES.has(upstream.status) && upstream.status !== "done") {
      continue;
    }

    if (upstream.status === "in_review" || upstream.status === "done") {
      reopened.push(await recordTaskStatusChange(cwd, upstream, "in_progress", {
        changedByAgentId: options.changedByAgentId || null,
        note: `Reopened after feedback from ${feedbackTask.id}`,
        blockingReason: feedback,
        resultSummary: null,
      }));

      await appendEvent(cwd, upstream.sessionId, "task.changes_requested", {
        taskId: upstream.id,
        feedbackTaskId: feedbackTask.id,
        feedback,
      }, feedbackTask.agentId);
    }
  }

  return reopened;
}

async function finalizeTaskIfDownstreamAccepted(cwd, taskId, options = {}) {
  const task = getTaskById(cwd, taskId);
  if (!task || TERMINAL_TASK_STATUSES.has(task.status) || task.status !== "in_review") {
    return {
      outcome: task ? "no_action" : "missing",
      task,
      pendingDependentTaskIds: [],
      feedback: [],
    };
  }

  const dependentValidators = listDependentTasks(cwd, task.id, {
    onlyBlocking: true,
    onlyValidatorTypes: true,
  });

  const pending = dependentValidators.filter((entry) => entry.status !== "done");
  const feedbackTasks = dependentValidators.filter((entry) => entry.status === "blocked" || entry.status === "failed");
  if (feedbackTasks.length) {
    const feedback = feedbackTasks.map((entry) => ({
      taskId: entry.id,
      agentId: entry.agentId,
      message: entry.blockingReason || entry.resultSummary || "Changes requested.",
    }));

    const reopened = await reopenUpstreamTasksFromFeedback(cwd, feedbackTasks[0], {
      changedByAgentId: options.changedByAgentId || null,
      note: feedback.map((entry) => entry.message).join("\n"),
    });

    return {
      outcome: "changes_requested",
      task: reopened[0] || getTaskById(cwd, task.id),
      pendingDependentTaskIds: pending.map((entry) => entry.id),
      feedback,
    };
  }

  if (pending.length) {
    await appendEvent(cwd, task.sessionId, "task.finalization_waiting", {
      taskId: task.id,
      pendingDependentTaskIds: pending.map((entry) => entry.id),
    }, task.agentId);

    return {
      outcome: "waiting",
      task,
      pendingDependentTaskIds: pending.map((entry) => entry.id),
      feedback: [],
    };
  }

  const doneTask = await recordTaskStatusChange(cwd, task, "done", {
    changedByAgentId: options.changedByAgentId || null,
    note: options.note || "All downstream validations completed",
    resultSummary: options.resultSummary !== undefined ? options.resultSummary : task.resultSummary,
    blockingReason: null,
  });

  await appendEvent(cwd, task.sessionId, "task.finalized", { taskId: doneTask.id }, doneTask.agentId);
  await refreshDependentTasks(cwd, task.id, options);

  return {
    outcome: "finalized",
    task: doneTask,
    pendingDependentTaskIds: [],
    feedback: [],
  };
}

async function waitForTaskAvailability(cwd, taskId, options = {}) {
  const pollIntervalMs = resolvePollInterval(options);

  while (true) {
    const task = getTaskById(cwd, taskId);
    if (!task) {
      throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${taskId}".`);
    }

    const promoted = await promoteTaskToReadyIfUnblocked(cwd, taskId, {
      changedByAgentId: options.changedByAgentId || null,
    });
    const hydrated = promoted ? getTaskById(cwd, taskId) : task;
    if (!hydrated.blockingTasks.length || TERMINAL_TASK_STATUSES.has(hydrated.status)) {
      return hydrated;
    }

    await appendEvent(cwd, hydrated.sessionId, "task.waiting_for_dependencies", {
      taskId: hydrated.id,
      dependsOnTaskIds: hydrated.blockingTasks.map((entry) => entry.dependsOnTaskId),
    }, hydrated.agentId);

    await sleep(pollIntervalMs);
  }
}

async function waitForTaskFinalization(cwd, taskId, options = {}) {
  const pollIntervalMs = resolvePollInterval(options);

  while (true) {
    const currentTask = getTaskById(cwd, taskId);
    if (!currentTask) {
      throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${taskId}".`);
    }

    if (currentTask.status === "done") {
      return {
        outcome: "finalized",
        task: currentTask,
        pendingDependentTaskIds: [],
        feedback: [],
      };
    }

    if (currentTask.status === "in_progress" && currentTask.blockingReason) {
      return {
        outcome: "changes_requested",
        task: currentTask,
        pendingDependentTaskIds: [],
        feedback: [
          {
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            message: currentTask.blockingReason,
          },
        ],
      };
    }

    const outcome = await finalizeTaskIfDownstreamAccepted(cwd, taskId, options);
    if (outcome.outcome !== "waiting") {
      return outcome;
    }

    await sleep(pollIntervalMs);
  }
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
      t.started_at AS startedAt,
      t.completed_at AS completedAt,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt
    FROM tasks t
    WHERE t.session_id = ? AND t.agent_id = ?
    ORDER BY CASE t.status
      WHEN 'in_progress' THEN 0
      WHEN 'in_review' THEN 1
      WHEN 'ready' THEN 2
      WHEN 'todo' THEN 3
      WHEN 'waiting' THEN 4
      WHEN 'blocked' THEN 5
      ELSE 6
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
    ...hydrateTask(cwd, task),
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

  let task = getCurrentTask(cwd, sessionId, agentId);
  if (task && computeWaitMode(options)) {
    const readyTask = await waitForTaskAvailability(cwd, task.id, {
      ...options,
      changedByAgentId: agentId,
    });
    task = {
      ...readyTask,
      availableAgents: task.availableAgents,
    };
  }

  return {
    agent,
    task,
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
  return getAll(cwd, sql, params).map((task) => hydrateTask(cwd, task));
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
    dependencies: normalizeDependencyDefinitions(options.dependsOn),
    reporter: options.reporter,
  });
}

async function updateTaskStatus(cwd, options = {}) {
  await ensureDatabase(cwd);
  const task = getTaskById(cwd, options.task);
  if (!task) {
    throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${options.task}".`);
  }

  const nextStatus = options.status;
  const changedByAgentId = resolveAgentIdentity(options);

  const updated = await recordTaskStatusChange(cwd, task, nextStatus, {
    changedByAgentId,
    blockingReason: options.blockingReason !== undefined ? options.blockingReason : nextStatus === "blocked" ? options.note || task.blockingReason : task.blockingReason,
    resultSummary: options.resultSummary !== undefined ? options.resultSummary : task.resultSummary,
    note: options.note || null,
  });

  await refreshDependentTasks(cwd, updated.id, {
    changedByAgentId,
  });

  if ((nextStatus === "blocked" || nextStatus === "failed") && VALIDATOR_TASK_TYPES.has(updated.taskType)) {
    await reopenUpstreamTasksFromFeedback(cwd, updated, {
      changedByAgentId,
      note: options.note || options.blockingReason || updated.blockingReason,
      resultSummary: options.resultSummary || updated.resultSummary,
    });
  }

  if (nextStatus === "done" && VALIDATOR_TASK_TYPES.has(updated.taskType)) {
    const upstreamDependencies = listTaskDependencies(cwd, updated.id).filter((entry) => entry.dependencyType === "blocks");
    for (const dependency of upstreamDependencies) {
      await finalizeTaskIfDownstreamAccepted(cwd, dependency.dependsOnTaskId, {
        changedByAgentId,
        note: options.note || null,
      });
    }
  }

  return getTaskById(cwd, task.id);
}

async function notifyTaskDone(cwd, options = {}) {
  await ensureDatabase(cwd);
  const task = getTaskById(cwd, options.task);
  if (!task) {
    throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${options.task}".`);
  }

  const changedByAgentId = resolveAgentIdentity(options);
  let currentTask = task;
  if (task.status !== "in_review") {
    currentTask = await recordTaskStatusChange(cwd, task, "in_review", {
      changedByAgentId,
      note: options.note || "Waiting for downstream validation",
      resultSummary: options.resultSummary !== undefined ? options.resultSummary : task.resultSummary,
      blockingReason: null,
    });

    await appendEvent(cwd, currentTask.sessionId, "task.finalization_started", { taskId: currentTask.id }, currentTask.agentId);
    await refreshDependentTasks(cwd, currentTask.id, {
      changedByAgentId,
      note: "Upstream implementation ready for validation",
    });
  }

  const outcome = await waitForTaskFinalization(cwd, currentTask.id, {
    ...options,
    changedByAgentId,
  });

  return outcome;
}

module.exports = {
  assignTask,
  createTask,
  createTaskDependencies,
  finalizeTaskIfDownstreamAccepted,
  getCurrentTask,
  getTaskById,
  getTaskContext,
  hasUnresolvedBlockingDependencies,
  listBlockingDependencies,
  listDependentTasks,
  listTaskDependencies,
  listTasks,
  notifyTaskDone,
  promoteTaskToReadyIfUnblocked,
  reopenUpstreamTasksFromFeedback,
  resolveAgentIdentity,
  resolveSessionIdentity,
  updateTaskStatus,
  waitForTaskAvailability,
  waitForTaskFinalization,
};
