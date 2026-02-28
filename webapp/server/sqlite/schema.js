import { ApiError } from "@/server/http/errors";
import { withReadOnlyDatabase } from "@/server/sqlite/connection";

const REQUIRED_TABLES = ["sessions", "agents", "tasks", "messages", "activity_logs"];

export function inspectSchema(dbPath) {
  return withReadOnlyDatabase(dbPath, (db) => {
    const rows = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name ASC`
      )
      .all();

    const detectedTables = rows.map((row) => row.name);
    const missingTables = REQUIRED_TABLES.filter((table) => !detectedTables.includes(table));

    if (missingTables.length > 0) {
      throw new ApiError(
        422,
        "INVALID_AGENTSQUAD_SCHEMA",
        "The SQLite database does not expose the expected AgentSquad tables.",
        { missingTables, detectedTables }
      );
    }

    return {
      detectedTables,
      missingTables,
    };
  });
}
