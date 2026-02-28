const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ensureWorkspace, getWorkspaceRoot } = require("./state");

const SQLITE_BUSY_TIMEOUT_MS = 30000;
const SQLITE_BUSY_RETRY_DELAY_MS = 100;

function getDatabasePath(cwd) {
  return path.join(getWorkspaceRoot(cwd), "agentsquad.db");
}

async function ensureDatabase(cwd) {
  await ensureWorkspace(cwd);
  withDatabase(cwd, (db) => {
    applyDatabasePragmas(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('planning','active','blocked','completed','failed','cancelled')),
        manager_agent_id TEXT,
        provider_id TEXT NOT NULL,
        root_workdir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('manager','worker')),
        provider_id TEXT NOT NULL,
        profile TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('created','idle','running','waiting','blocked','stopped','completed','failed')),
        mode TEXT NOT NULL DEFAULT 'oneshot',
        workdir TEXT NOT NULL,
        current_task_id TEXT,
        parent_agent_id TEXT,
        created_by_agent_id TEXT,
        system_prompt TEXT,
        launch_command TEXT,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_agent_id) REFERENCES agents(id),
        FOREIGN KEY(created_by_agent_id) REFERENCES agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_agents_session_id ON agents(session_id);
      CREATE INDEX IF NOT EXISTS idx_agents_session_role ON agents(session_id, role);
      CREATE INDEX IF NOT EXISTS idx_agents_session_status ON agents(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        parent_task_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('todo','ready','in_progress','waiting','blocked','in_review','done','failed','cancelled')),
        priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','critical')) DEFAULT 'medium',
        task_type TEXT NOT NULL CHECK(task_type IN ('planning','implementation','testing','review','research','coordination','other')),
        scope_path TEXT,
        acceptance_criteria TEXT,
        blocking_reason TEXT,
        result_summary TEXT,
        created_by_agent_id TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_task_id) REFERENCES tasks(id),
        FOREIGN KEY(created_by_agent_id) REFERENCES agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

      CREATE TABLE IF NOT EXISTS task_dependencies (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        dependency_type TEXT NOT NULL CHECK(dependency_type IN ('blocks','relates_to','duplicates','parent_of')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id, depends_on_task_id, dependency_type)
      );

      CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends ON task_dependencies(depends_on_task_id);

      CREATE TABLE IF NOT EXISTS task_status_history (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        changed_by_agent_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(changed_by_agent_id) REFERENCES agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_status_history_task ON task_status_history(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_id TEXT,
        from_type TEXT NOT NULL CHECK(from_type IN ('user','agent','system')),
        from_agent_id TEXT,
        to_agent_id TEXT,
        message_kind TEXT NOT NULL CHECK(message_kind IN ('instruction','question','update','review','handoff','note','system')),
        text TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK(delivery_status IN ('queued','delivered','failed','read')),
        related_task_id TEXT,
        reply_to_message_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(from_agent_id) REFERENCES agents(id),
        FOREIGN KEY(to_agent_id) REFERENCES agents(id),
        FOREIGN KEY(related_task_id) REFERENCES tasks(id),
        FOREIGN KEY(reply_to_message_id) REFERENCES messages(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_related_task ON messages(related_task_id);

      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_activity_logs_session ON activity_logs(session_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_agent ON activity_logs(agent_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT,
        pid INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        status TEXT NOT NULL CHECK(status IN ('starting','running','completed','failed','killed')),
        stdout_path TEXT,
        stderr_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('file','plan','report','patch','log','other')),
        path TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES agents(id),
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
    `);

    const columns = db.prepare("PRAGMA table_info(agents)").all();
    if (!columns.find((column) => column.name === "mode")) {
      db.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'oneshot'");
    }
  });
}

function withDatabase(cwd, callback) {
  const startedAt = Date.now();

  while (true) {
    const db = new DatabaseSync(getDatabasePath(cwd));
    applyDatabasePragmas(db);

    try {
      return callback(db);
    } catch (error) {
      if (!isBusyError(error) || Date.now() - startedAt >= SQLITE_BUSY_TIMEOUT_MS) {
        throw error;
      }

      db.close();
      sleep(SQLITE_BUSY_RETRY_DELAY_MS);
      continue;
    } finally {
      try {
        db.close();
      } catch {
        // Ignore close errors on retry paths.
      }
    }
  }
}

function getOne(cwd, sql, params = []) {
  return withDatabase(cwd, (db) => db.prepare(sql).get(...params) || null);
}

function getAll(cwd, sql, params = []) {
  return withDatabase(cwd, (db) => db.prepare(sql).all(...params));
}

function runStatement(cwd, sql, params = []) {
  return withDatabase(cwd, (db) => db.prepare(sql).run(...params));
}

module.exports = {
  ensureDatabase,
  getAll,
  getDatabasePath,
  getOne,
  runStatement,
  withDatabase,
};

function applyDatabasePragmas(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA synchronous = NORMAL");
}

function isBusyError(error) {
  const message = String((error && error.message) || "");
  return message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("SQLITE_BUSY");
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}
