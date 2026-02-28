import { ApiError } from "@/server/http/errors";
import { normalizeAndValidateDatabasePath } from "@/server/sqlite/connection";
import { getDataSource, registerDataSource } from "@/server/sqlite/source-registry";
import { inspectSchema } from "@/server/sqlite/schema";
import {
  getSessionSnapshot,
  getSessionSummary,
  listSessions,
} from "@/server/sqlite/queries";

function clampLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 1_000);
}

export async function connectDataSource(inputPath) {
  const dbPath = await normalizeAndValidateDatabasePath(inputPath);
  const schema = await inspectSchema(dbPath);
  return registerDataSource(dbPath, schema.detectedTables);
}

export function requireDataSource(sourceId) {
  const source = getDataSource(sourceId);

  if (!source) {
    throw new ApiError(404, "SOURCE_NOT_FOUND", `No data source found for "${sourceId}".`);
  }

  return source;
}

export async function listSourceSessions(sourceId) {
  const source = requireDataSource(sourceId);
  return listSessions(source.dbPath);
}

export async function getMonitoredSessionSnapshot(sourceId, sessionId, searchParams) {
  const source = requireDataSource(sourceId);
  const options = {
    messagesLimit: clampLimit(searchParams.get("messagesLimit"), 200),
    logsLimit: clampLimit(searchParams.get("logsLimit"), 200),
  };

  return getSessionSnapshot(source.dbPath, sessionId, options);
}

export async function getMonitoredSessionSummary(sourceId, sessionId, searchParams) {
  const source = requireDataSource(sourceId);
  const options = {
    messagesLimit: clampLimit(searchParams.get("messagesLimit"), 200),
    logsLimit: clampLimit(searchParams.get("logsLimit"), 200),
  };

  return getSessionSummary(source.dbPath, sessionId, options);
}
