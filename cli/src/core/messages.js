const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureWorkspace, ensureAgentWorkspace, getSessionRoot } = require("./state");
const { createId } = require("./ids");
const { appendJsonl, readJsonl } = require("../utils/jsonl");
const { resolveAgent } = require("./agents");
const { appendEvent } = require("./events");
const { AgentsquadError } = require("./errors");
const { mergeProviderConfig, resolveProvider } = require("../providers/adapter-registry");
const { runOneshotProcess } = require("./process-manager");

function getMessagesPath(cwd, sessionId) {
  return path.join(getSessionRoot(cwd, sessionId), "messages.jsonl");
}

async function sendMessage(cwd, config, options) {
  const sessionId = options.session || config.defaultSession || "default";
  await ensureWorkspace(cwd, sessionId);

  const text = await resolveMessageText(options);
  const target = await resolveAgent(cwd, sessionId, options.to);
  const source = options.from ? await resolveAgent(cwd, sessionId, options.from) : null;

  const message = {
    id: createId("msg"),
    sessionId,
    from: source ? source.id : undefined,
    fromType: source ? "agent" : "user",
    to: target.id,
    text,
    createdAt: new Date().toISOString(),
    deliveryStatus: "queued",
  };

  await appendJsonl(getMessagesPath(cwd, sessionId), message);

  const targetWorkspace = await ensureAgentWorkspace(cwd, sessionId, target.id);
  await appendJsonl(targetWorkspace.inboxPath, message);
  await appendEvent(cwd, sessionId, "message.queued", { messageId: message.id, from: message.from || "user" }, target.id);

  const providerConfig = mergeProviderConfig(config, target.providerId, target.profile);
  const adapter = resolveProvider(target.providerId);

  if (providerConfig.mode === "oneshot") {
    const delivery = await adapter.deliverMessage(target, providerConfig, message, targetWorkspace);
    message.deliveryStatus = delivery.ok ? "delivered" : "failed";
    message.delivery = delivery;
    await appendJsonl(getMessagesPath(cwd, sessionId), message);
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
  const rows = await readJsonl(getMessagesPath(cwd, sessionId));
  const messages = dedupeMessages(rows);
  if (!options.agent) {
    return messages;
  }

  return messages.filter((entry) => entry.to === options.agent || entry.from === options.agent);
}

function dedupeMessages(rows) {
  const byId = new Map();

  for (const row of rows) {
    byId.set(row.id, row);
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

module.exports = {
  listMessages,
  sendMessage,
};
