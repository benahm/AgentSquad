import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/server/http/errors";

const REQUIRED_FILES = ["session.jsonl", "agents.jsonl", "tasks.jsonl", "messages.jsonl", "activity-logs.jsonl"];

export async function inspectSchema(workspacePath) {
  const sessionsRoot = path.join(workspacePath, "sessions");
  let sessionDirs = [];
  try {
    sessionDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    throw new ApiError(422, "INVALID_AGENTSQUAD_SCHEMA", "The AgentSquad workspace does not expose a sessions directory.");
  }

  const detectedFiles = new Set(["sessions/"]);
  for (const entry of sessionDirs) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionRoot = path.join(sessionsRoot, entry.name);
    const files = await fs.readdir(sessionRoot);
    for (const file of files) {
      detectedFiles.add(file);
    }
  }

  const missingFiles = REQUIRED_FILES.filter((file) => !detectedFiles.has(file));
  if (missingFiles.length > 0) {
    throw new ApiError(
      422,
      "INVALID_AGENTSQUAD_SCHEMA",
      "The AgentSquad workspace does not expose the expected JSONL files.",
      { missingFiles, detectedFiles: [...detectedFiles].sort() }
    );
  }

  return {
    detectedFiles: [...detectedFiles].sort(),
    missingFiles,
  };
}
