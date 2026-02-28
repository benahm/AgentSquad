import { ApiError } from "@/server/http/errors";
import { normalizeAndValidateWorkspacePath } from "@/server/jsonl/connection";
import { getDataSource, registerDataSource } from "@/server/jsonl/source-registry";
import { inspectSchema } from "@/server/jsonl/schema";
import {
  getSessionSnapshot,
  getSessionSummary,
  listSessions,
} from "@/server/jsonl/queries";

function clampLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 1_000);
}

export async function connectDataSource(inputPath) {
  const workspacePath = await normalizeAndValidateWorkspacePath(inputPath);
  const schema = await inspectSchema(workspacePath);
  return registerDataSource(workspacePath, schema.detectedFiles);
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
  return listSessions(source.workspacePath);
}

export async function getMonitoredSessionSnapshot(sourceId, sessionId, searchParams) {
  const source = requireDataSource(sourceId);
  const options = {
    messagesLimit: clampLimit(searchParams.get("messagesLimit"), 200),
    logsLimit: clampLimit(searchParams.get("logsLimit"), 200),
  };

  return getSessionSnapshot(source.workspacePath, sessionId, options);
}

export async function getMonitoredSessionSummary(sourceId, sessionId, searchParams) {
  const source = requireDataSource(sourceId);
  const options = {
    messagesLimit: clampLimit(searchParams.get("messagesLimit"), 200),
    logsLimit: clampLimit(searchParams.get("logsLimit"), 200),
  };

  return getSessionSummary(source.workspacePath, sessionId, options);
}
