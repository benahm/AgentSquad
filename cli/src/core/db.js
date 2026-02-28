const { ensureSessionStore } = require("./store");
const { AgentsquadError } = require("./errors");

async function ensureDatabase(cwd, sessionId = "default") {
  return ensureSessionStore(cwd, sessionId);
}

function unsupported() {
  throw new AgentsquadError("SQLITE_REMOVED", "SQLite persistence has been removed. Use the JSONL store APIs instead.");
}

module.exports = {
  ensureDatabase,
  getAll: unsupported,
  getOne: unsupported,
  runStatement: unsupported,
  withDatabase: unsupported,
};
