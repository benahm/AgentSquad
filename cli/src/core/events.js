const path = require("node:path");
const { appendJsonl, readJsonl } = require("../utils/jsonl");
const { ensureWorkspace, getSessionRoot } = require("./state");
const { createId } = require("./ids");

function getSessionEventsPath(cwd, sessionId) {
  return path.join(getSessionRoot(cwd, sessionId), "events.jsonl");
}

async function appendEvent(cwd, sessionId, type, payload = {}, agentId) {
  await ensureWorkspace(cwd, sessionId);

  const event = {
    id: createId("evt"),
    sessionId,
    agentId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };

  await appendJsonl(getSessionEventsPath(cwd, sessionId), event);
  return event;
}

async function listEvents(cwd, options = {}) {
  await ensureWorkspace(cwd, options.session || "default");
  const events = await readJsonl(getSessionEventsPath(cwd, options.session || "default"));
  if (!options.agent) {
    return events;
  }

  return events.filter((entry) => entry.agentId === options.agent);
}

module.exports = {
  appendEvent,
  listEvents,
};
