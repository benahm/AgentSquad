const { createId } = require("./ids");
const { ensureDatabase, getAll, runStatement } = require("./db");

async function appendActivityLog(cwd, input) {
  await ensureDatabase(cwd);
  const entry = {
    id: createId("log"),
    sessionId: input.sessionId,
    agentId: input.agentId || null,
    level: input.level || "info",
    kind: input.kind || "activity",
    message: input.message,
    details: input.details ? JSON.stringify(input.details) : null,
    createdAt: new Date().toISOString(),
  };

  runStatement(
    cwd,
    `INSERT INTO activity_logs (
      id, session_id, agent_id, level, kind, message, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.sessionId,
      entry.agentId,
      entry.level,
      entry.kind,
      entry.message,
      entry.details,
      entry.createdAt,
    ]
  );

  if (typeof input.reporter === "function") {
    input.reporter(entry.message, entry);
  }

  return entry;
}

async function listActivityLogs(cwd, options = {}) {
  await ensureDatabase(cwd);
  const sessionId = options.session || "default";
  const params = [sessionId];
  let sql = `
    SELECT
      id,
      session_id AS sessionId,
      agent_id AS agentId,
      level,
      kind,
      message,
      details_json AS detailsJson,
      created_at AS createdAt
    FROM activity_logs
    WHERE session_id = ?`;

  if (options.agent) {
    sql += " AND agent_id = ?";
    params.push(options.agent);
  }

  sql += " ORDER BY created_at ASC";
  return getAll(cwd, sql, params);
}

module.exports = {
  appendActivityLog,
  listActivityLogs,
};
