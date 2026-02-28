const { createId } = require("./ids");
const { appendRecord, readRecords } = require("./store");

async function appendActivityLog(cwd, input) {
  const entry = {
    id: createId("log"),
    sessionId: input.sessionId,
    agentId: input.agentId || null,
    level: input.level || "info",
    kind: input.kind || "activity",
    message: input.message,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
    createdAt: new Date().toISOString(),
  };

  await appendRecord(cwd, entry.sessionId, "activityLogs", entry);

  if (typeof input.reporter === "function") {
    input.reporter(entry.message, entry);
  }

  return entry;
}

async function listActivityLogs(cwd, options = {}) {
  const sessionId = options.session || "default";
  const rows = await readRecords(cwd, sessionId, "activityLogs");
  return rows
    .filter((entry) => !options.agent || entry.agentId === options.agent)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

module.exports = {
  appendActivityLog,
  listActivityLogs,
};
