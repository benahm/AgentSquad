const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureWorkspace, ensureAgentWorkspace, getMessagesPath } = require("./state");
const { createId } = require("./ids");
const { appendJsonl } = require("../utils/jsonl");
const { resolveAgent } = require("./agents");
const { appendEvent } = require("./events");
const { appendActivityLog } = require("./activity-logs");
const { AgentsquadError } = require("./errors");
const { resolveAgentIdentity } = require("./tasks");
const { mergeProviderConfig, resolveProvider } = require("../providers/adapter-registry");
const { projectLatestById, appendSnapshot, readSnapshots } = require("./store");

function formatProviderStreamLine(agent, providerId, stream, line) {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return null;
  }

  const label = providerId === "codex" && stream === "stderr" ? "log" : stream;
  return `${agent.id} ${label}: ${normalized}`;
}

function summarizeDeliveryFailure(providerId, lines) {
  const normalized = lines.map((line) => String(line || "").trim()).filter(Boolean);
  if (!normalized.length) {
    return null;
  }

  if (providerId === "codex") {
    if (normalized.some((line) => line.includes("&&") && /séparateur|separator/i.test(line))) {
      return "Likely cause: Codex ran a PowerShell command with `&&`, which Windows PowerShell does not support. Use `;` instead.";
    }
    if (normalized.some((line) => /ParserError|InvalidEndOfLine/.test(line))) {
      return "Likely cause: the generated PowerShell command has invalid shell syntax for Windows PowerShell.";
    }
    const exitedLine = normalized.find((line) => /\bexited\s+[1-9]/i.test(line));
    if (exitedLine) {
      return `Provider command failed: ${exitedLine}`;
    }
  }

  return normalized.find((line) => /error|failed|exception|exited\s+[1-9]/i.test(line)) || normalized[0];
}

async function sendMessage(cwd, config, options) {
  const sessionId = options.session || config.defaultSession || "default";
  await ensureWorkspace(cwd, sessionId);

  const text = await resolveMessageText(options);
  const target = await resolveAgent(cwd, sessionId, options.to);
  const sourceRef = options.from || resolveAgentIdentity(options);
  const source = sourceRef ? await resolveAgent(cwd, sessionId, sourceRef) : null;

  const message = {
    id: createId("msg"),
    sessionId,
    threadId: options.threadId || null,
    from: source ? source.id : null,
    fromType: source ? "agent" : "user",
    to: target.id,
    messageKind: options.kind || "instruction",
    text,
    deliveryStatus: "queued",
    relatedTaskId: options.relatedTaskId || null,
    replyToMessageId: options.replyToMessageId || null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
  };

  await appendSnapshot(cwd, sessionId, "messages", message);
  const targetWorkspace = await ensureAgentWorkspace(cwd, sessionId, target.id);
  await appendJsonl(targetWorkspace.inboxPath, message);
  await appendEvent(cwd, sessionId, "message.queued", { messageId: message.id, from: message.from || "user" }, target.id);
  await appendActivityLog(cwd, {
    sessionId,
    agentId: target.id,
    kind: "message.queue",
    message: `${source ? source.id : "user"} -> ${target.id}: ${message.messageKind}`,
    details: {
      messageId: message.id,
    },
    reporter: options.reporter,
  });

  const providerConfig = mergeProviderConfig(config, target.providerId, target.profile);
  const adapter = resolveProvider(target.providerId);

  if (providerConfig.mode === "oneshot") {
    const streamedStdoutLines = [];
    const streamedStderrLines = [];
    const delivery = await adapter.deliverMessage(target, providerConfig, {
      ...message,
      reporter: options.reporter,
      onStdout: async (line) => {
        streamedStdoutLines.push(line);
        const formatted = formatProviderStreamLine(target, target.providerId, "output", line);
        if (formatted && typeof options.reporter === "function") {
          options.reporter(formatted);
        }
      },
      onStderr: async (line) => {
        streamedStderrLines.push(line);
        const formatted = formatProviderStreamLine(target, target.providerId, "stderr", line);
        if (formatted && typeof options.reporter === "function") {
          options.reporter(formatted);
        }
      },
    }, targetWorkspace);

    for (const line of streamedStdoutLines) {
      await appendActivityLog(cwd, {
        sessionId,
        agentId: target.id,
        kind: "agent.stdout",
        message: `${target.id} output: ${line}`,
      });
    }

    for (const line of streamedStderrLines) {
      await appendActivityLog(cwd, {
        sessionId,
        agentId: target.id,
        kind: "agent.stderr",
        level: "warning",
        message: `${target.id} error: ${line}`,
      });
    }

    message.deliveryStatus = delivery.ok ? "delivered" : "failed";
    message.delivery = delivery;
    message.deliveredAt = new Date().toISOString();
    await appendSnapshot(cwd, sessionId, "messages", message);
    await appendJsonl(targetWorkspace.outboxPath, {
      id: createId("delivery"),
      messageId: message.id,
      timestamp: new Date().toISOString(),
      ...delivery,
    });
    await appendEvent(
      cwd,
      sessionId,
      delivery.ok ? "message.delivered" : "message.delivery_failed",
      { messageId: message.id, providerId: target.providerId, code: delivery.code, signal: delivery.signal },
      target.id
    );
    await appendActivityLog(cwd, {
      sessionId,
      agentId: target.id,
      kind: "message.delivery",
      level: delivery.ok ? "info" : "error",
      message: delivery.ok
        ? `${target.id} received: ${message.messageKind}`
        : `${target.id} failed delivery: ${message.messageKind}`,
      details: {
        messageId: message.id,
        code: delivery.code,
        signal: delivery.signal,
      },
      reporter: options.reporter,
    });

    if (!delivery.ok && typeof options.reporter === "function") {
      const failureSummary = summarizeDeliveryFailure(target.providerId, streamedStderrLines);
      if (failureSummary) {
        options.reporter(`${target.id} failure reason: ${failureSummary}`);
      }
    }
  } else {
    await appendEvent(cwd, sessionId, "message.deferred", { messageId: message.id }, target.id);
  }

  return {
    message,
    target,
  };
}

async function resolveMessageText(options) {
  if (options.text) {
    return options.text;
  }

  if (options.file) {
    return fs.readFile(path.resolve(options.file), "utf8");
  }

  throw new AgentsquadError("MESSAGE_EMPTY", "Provide either --text or --file.");
}

async function listMessages(cwd, options = {}) {
  const sessionId = options.session || "default";
  await ensureWorkspace(cwd, sessionId);
  const messages = projectLatestById(await readSnapshots(cwd, sessionId, "messages"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!options.agent) {
    return messages;
  }

  return messages.filter((entry) => entry.to === options.agent || entry.from === options.agent);
}

module.exports = {
  listMessages,
  sendMessage,
};
