const { createId } = require("./ids");
const { appendEvent } = require("./events");
const { appendActivityLog } = require("./activity-logs");
const { AgentsquadError } = require("./errors");
const { appendRecord, appendSnapshot, readRecords, readSnapshots } = require("./store");

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

async function loadAgents(cwd, sessionId) {
  return (await readSnapshots(cwd, sessionId, "agents")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function loadTasks(cwd, sessionId) {
  return (await readSnapshots(cwd, sessionId, "tasks")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function loadDependencies(cwd, sessionId) {
  return (await readRecords(cwd, sessionId, "taskDependencies")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function appendTaskSnapshot(cwd, task) {
  return appendSnapshot(cwd, task.sessionId, "tasks", task);
}

async function createTask(cwd, input) {
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

  await appendTaskSnapshot(cwd, task);
  await appendRecord(cwd, task.sessionId, "taskStatusHistory", {
    id: createId("taskstatus"),
    sessionId: task.sessionId,
    taskId: task.id,
    fromStatus: null,
    toStatus: task.status,
    changedByAgentId: task.createdByAgentId,
    note: "Task created",
    createdAt: now,
  });

  const dependencies = normalizeDependencyDefinitions(input.dependencies);
  if (dependencies.length) {
    await createTaskDependencies(cwd, task.sessionId, task.id, dependencies, {
      changedByAgentId: task.createdByAgentId,
    });
  }

  await updateAgentCurrentTask(cwd, task.sessionId, task.agentId, task.id, now);
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
    sessionId: task.sessionId,
  });

  return getTaskById(cwd, task.id, task.sessionId);
}

async function updateAgentCurrentTask(cwd, sessionId, agentId, taskId, updatedAt) {
  const agents = await loadAgents(cwd, sessionId);
  const agent = agents.find((entry) => entry.id === agentId);
  if (!agent) {
    return;
  }

  await appendSnapshot(cwd, sessionId, "agents", {
    ...agent,
    currentTaskId: taskId,
    updatedAt,
  });
}

async function createTaskDependencies(cwd, sessionId, taskId, dependencies, options = {}) {
  const normalized = normalizeDependencyDefinitions(dependencies);
  if (!normalized.length) {
    return [];
  }

  const existing = await loadDependencies(cwd, sessionId);
  const now = new Date().toISOString();
  for (const entry of normalized) {
    if (existing.some((row) => row.taskId === taskId && row.dependsOnTaskId === entry.dependsOnTaskId && row.dependencyType === entry.dependencyType)) {
      continue;
    }

    await appendRecord(cwd, sessionId, "taskDependencies", {
      id: createId("taskdep"),
      sessionId,
      taskId,
      dependsOnTaskId: entry.dependsOnTaskId,
      dependencyType: entry.dependencyType,
      createdAt: now,
    });
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

async function getTaskById(cwd, taskId, sessionIdHint = null) {
  const sessionId = await findTaskSessionId(cwd, taskId, sessionIdHint);
  if (!sessionId) {
    return null;
  }

  const tasks = await loadTasks(cwd, sessionId);
  const task = tasks.find((entry) => entry.id === taskId);
  return task ? hydrateTask(cwd, task) : null;
}

async function findTaskSessionId(cwd, taskId, sessionIdHint = null) {
  if (sessionIdHint) {
    const hintedTasks = await loadTasks(cwd, sessionIdHint);
    if (hintedTasks.some((entry) => entry.id === taskId)) {
      return sessionIdHint;
    }
  }

  const { listSessions } = require("./store");
  const sessions = await listSessions(cwd);
  for (const session of sessions) {
    const tasks = await loadTasks(cwd, session.id);
    if (tasks.some((entry) => entry.id === taskId)) {
      return session.id;
    }
  }

  return null;
}

async function hydrateTask(cwd, task) {
  const dependencies = await listTaskDependencies(cwd, task.id, task.sessionId);
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

async function listTaskDependencies(cwd, taskId, sessionIdHint = null) {
  const sessionId = await findTaskSessionId(cwd, taskId, sessionIdHint);
  if (!sessionId) {
    return [];
  }

  const [dependencies, tasks] = await Promise.all([
    loadDependencies(cwd, sessionId),
    loadTasks(cwd, sessionId),
  ]);

  return dependencies
    .filter((entry) => entry.taskId === taskId)
    .map((entry) => {
      const task = tasks.find((candidate) => candidate.id === entry.dependsOnTaskId);
      return {
        ...entry,
        dependsOnTaskTitle: task ? task.title : null,
        dependsOnTaskStatus: task ? task.status : null,
        dependsOnTaskType: task ? task.taskType : null,
        dependsOnAgentId: task ? task.agentId : null,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function listBlockingDependencies(cwd, taskId, sessionIdHint = null) {
  const task = await getTaskById(cwd, taskId, sessionIdHint);
  if (!task) {
    return [];
  }

  return (await listTaskDependencies(cwd, taskId, task.sessionId)).filter((entry) => {
    if (entry.dependencyType !== "blocks") {
      return false;
    }

    return !isDependencySatisfiedForTask(task.taskType, entry.dependsOnTaskStatus);
  });
}

async function listDependentTasks(cwd, taskId, options = {}) {
  const sessionId = await findTaskSessionId(cwd, taskId, options.sessionId || null);
  if (!sessionId) {
    return [];
  }

  const onlyBlocking = options.onlyBlocking !== false;
  const filterValidatorTypes = options.onlyValidatorTypes === true;
  const [dependencies, tasks] = await Promise.all([
    loadDependencies(cwd, sessionId),
    loadTasks(cwd, sessionId),
  ]);

  const dependents = tasks.filter((task) => dependencies.some((dependency) => {
    if (dependency.dependsOnTaskId !== taskId || dependency.taskId !== task.id) {
      return false;
    }
    return !onlyBlocking || dependency.dependencyType === "blocks";
  }));

  const filtered = filterValidatorTypes
    ? dependents.filter((task) => task.taskType === "testing" || task.taskType === "review")
    : dependents;

  const hydrated = [];
  for (const task of filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    hydrated.push(await hydrateTask(cwd, task));
  }
  return hydrated;
}

async function hasUnresolvedBlockingDependencies(cwd, taskId, sessionIdHint = null) {
  return (await listBlockingDependencies(cwd, taskId, sessionIdHint)).length > 0;
}

async function recordTaskStatusChange(cwd, task, nextStatus, options = {}) {
  const now = new Date().toISOString();
  const startedAt = nextStatus === "in_progress" && !task.startedAt ? now : task.startedAt;
  const completedAt = nextStatus === "done" ? now : TERMINAL_TASK_STATUSES.has(nextStatus) ? task.completedAt || now : null;
  const updatedTask = {
    ...task,
    status: nextStatus,
    blockingReason: options.blockingReason !== undefined ? options.blockingReason : task.blockingReason || null,
    resultSummary: options.resultSummary !== undefined ? options.resultSummary : task.resultSummary || null,
    startedAt,
    completedAt,
    updatedAt: now,
  };

  await appendTaskSnapshot(cwd, updatedTask);
  await appendRecord(cwd, task.sessionId, "taskStatusHistory", {
    id: createId("taskstatus"),
    sessionId: task.sessionId,
    taskId: task.id,
    fromStatus: task.status,
    toStatus: nextStatus,
    changedByAgentId: options.changedByAgentId || null,
    note: options.note || null,
    createdAt: now,
  });

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

  return getTaskById(cwd, task.id, task.sessionId);
}

async function promoteTaskToReadyIfUnblocked(cwd, taskId, options = {}) {
  const task = await getTaskById(cwd, taskId, options.sessionId || null);
  if (!task || TERMINAL_TASK_STATUSES.has(task.status) || task.status === "in_review" || task.status === "in_progress") {
    return task;
  }

  if (await hasUnresolvedBlockingDependencies(cwd, taskId, task.sessionId)) {
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
  const dependents = await listDependentTasks(cwd, taskId, { onlyBlocking: true, sessionId: options.sessionId || null });
  const refreshed = [];
  for (const dependent of dependents) {
    refreshed.push(await promoteTaskToReadyIfUnblocked(cwd, dependent.id, options));
  }

  return refreshed;
}

async function reopenUpstreamTasksFromFeedback(cwd, feedbackTask, options = {}) {
  const dependencies = (await listTaskDependencies(cwd, feedbackTask.id, feedbackTask.sessionId)).filter((entry) => entry.dependencyType === "blocks");
  const reopened = [];
  const feedback = options.note || options.resultSummary || feedbackTask.resultSummary || feedbackTask.blockingReason || "Changes requested by downstream validation.";

  for (const dependency of dependencies) {
    const upstream = await getTaskById(cwd, dependency.dependsOnTaskId, feedbackTask.sessionId);
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
  const task = await getTaskById(cwd, taskId, options.sessionId || null);
  if (!task || TERMINAL_TASK_STATUSES.has(task.status) || task.status !== "in_review") {
    return {
      outcome: task ? "no_action" : "missing",
      task,
      pendingDependentTaskIds: [],
      feedback: [],
    };
  }

  const dependentValidators = await listDependentTasks(cwd, task.id, {
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
      task: reopened[0] || await getTaskById(cwd, task.id, task.sessionId),
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
    const task = await getTaskById(cwd, taskId, options.sessionId || null);
    if (!task) {
      throw new AgentsquadError("TASK_NOT_FOUND", `No task found for "${taskId}".`);
    }

    const promoted = await promoteTaskToReadyIfUnblocked(cwd, taskId, {
      changedByAgentId: options.changedByAgentId || null,
    });
    const hydrated = promoted ? await getTaskById(cwd, taskId, task.sessionId) : task;
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
    const currentTask = await getTaskById(cwd, taskId, options.sessionId || null);
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

async function getCurrentTask(cwd, sessionId, agentId) {
  const tasks = await loadTasks(cwd, sessionId);
  const sorted = tasks
    .filter((entry) => entry.sessionId === sessionId && entry.agentId === agentId)
    .sort((a, b) => {
      const order = {
        in_progress: 0,
        in_review: 1,
        ready: 2,
        todo: 3,
        waiting: 4,
        blocked: 5,
      };
      const delta = (order[a.status] ?? 6) - (order[b.status] ?? 6);
      if (delta !== 0) {
        return delta;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

  const task = sorted[0];
  if (!task) {
    return null;
  }

  const agents = await loadAgents(cwd, sessionId);
  const availableAgents = agents
    .filter((entry) => entry.id !== agentId)
    .map((agent) => {
      const currentTask = tasks.find((entry) => entry.id === agent.currentTaskId) || null;
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        taskTitle: currentTask ? currentTask.title : null,
        taskStatus: currentTask ? currentTask.status : null,
      };
    })
    .sort((a, b) => `${a.role}:${a.id}`.localeCompare(`${b.role}:${b.id}`));

  return {
    ...(await hydrateTask(cwd, task)),
    availableAgents,
  };
}

async function getTaskContext(cwd, options = {}) {
  const agentId = resolveAgentIdentity(options);
  const sessionId = resolveSessionIdentity(options);
  if (!agentId) {
    throw new AgentsquadError("AGENT_ID_REQUIRED", "Unable to resolve the current agent. Provide --agent or set AGENTSQUAD_AGENT_ID.");
  }

  const agents = await loadAgents(cwd, sessionId);
  const agent = agents.find((entry) => entry.id === agentId && entry.sessionId === sessionId);

  if (!agent) {
    throw new AgentsquadError("AGENT_NOT_FOUND", `No agent found for "${agentId}" in session "${sessionId}".`);
  }

  let task = await getCurrentTask(cwd, sessionId, agentId);
  if (task && computeWaitMode(options)) {
    const readyTask = await waitForTaskAvailability(cwd, task.id, {
      ...options,
      changedByAgentId: agentId,
      sessionId,
    });
    task = {
      ...readyTask,
      availableAgents: task.availableAgents,
    };
  }

  return {
    agent: {
      id: agent.id,
      sessionId: agent.sessionId,
      name: agent.name,
      role: agent.role,
      goal: agent.goal,
      status: agent.status,
      currentTaskId: agent.currentTaskId,
      workdir: agent.workdir,
    },
    task,
  };
}

async function listTasks(cwd, options = {}) {
  const sessionId = resolveSessionIdentity(options);
  const tasks = (await loadTasks(cwd, sessionId))
    .filter((entry) => !options.agent || entry.agentId === options.agent)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const hydrated = [];
  for (const task of tasks) {
    hydrated.push(await hydrateTask(cwd, task));
  }
  return hydrated;
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
  const sessionId = resolveSessionIdentity(options);
  const task = await getTaskById(cwd, options.task, sessionId);
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
    sessionId: updated.sessionId,
  });

  if ((nextStatus === "blocked" || nextStatus === "failed") && VALIDATOR_TASK_TYPES.has(updated.taskType)) {
    await reopenUpstreamTasksFromFeedback(cwd, updated, {
      changedByAgentId,
      note: options.note || options.blockingReason || updated.blockingReason,
      resultSummary: options.resultSummary || updated.resultSummary,
    });
  }

  if (nextStatus === "done" && VALIDATOR_TASK_TYPES.has(updated.taskType)) {
    const upstreamDependencies = (await listTaskDependencies(cwd, updated.id, updated.sessionId)).filter((entry) => entry.dependencyType === "blocks");
    for (const dependency of upstreamDependencies) {
      await finalizeTaskIfDownstreamAccepted(cwd, dependency.dependsOnTaskId, {
        changedByAgentId,
        note: options.note || null,
        sessionId: updated.sessionId,
      });
    }
  }

  return getTaskById(cwd, task.id, task.sessionId);
}

async function notifyTaskDone(cwd, options = {}) {
  const sessionId = resolveSessionIdentity(options);
  const task = await getTaskById(cwd, options.task, sessionId);
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
      sessionId: currentTask.sessionId,
      note: "Upstream implementation ready for validation",
    });
  }

  return waitForTaskFinalization(cwd, currentTask.id, {
    ...options,
    changedByAgentId,
    sessionId: currentTask.sessionId,
  });
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
