import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/server/http/errors";

function normalizeInputPath(inputPath) {
  const trimmed = inputPath.trim();
  const windowsDriveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);

  if (!windowsDriveMatch) {
    return path.resolve(trimmed);
  }

  if (process.platform === "win32") {
    return path.resolve(trimmed);
  }

  const drive = windowsDriveMatch[1].toLowerCase();
  const remainder = windowsDriveMatch[2].replaceAll("\\", "/");
  return path.posix.join("/mnt", drive, remainder);
}

async function resolveWorkspaceRoot(inputPath) {
  const normalized = normalizeInputPath(inputPath);
  const direct = path.basename(normalized) === ".agentsquad" ? normalized : path.join(normalized, ".agentsquad");
  try {
    const stat = await fs.stat(direct);
    if (!stat.isDirectory()) {
      throw new ApiError(400, "INVALID_WORKSPACE_PATH", "The AgentSquad workspace path must point to a directory.");
    }
    await fs.access(direct, fsConstants.R_OK);
    return direct;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(400, "INVALID_WORKSPACE_PATH", `Unable to read AgentSquad workspace at "${direct}".`);
  }
}

export async function normalizeAndValidateWorkspacePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new ApiError(400, "INVALID_WORKSPACE_PATH", "An AgentSquad workspace path is required.");
  }
  if (inputPath.trim().endsWith(".db")) {
    throw new ApiError(400, "INVALID_WORKSPACE_PATH", "SQLite databases are no longer supported. Provide a .agentsquad workspace path.");
  }
  return resolveWorkspaceRoot(inputPath);
}

export async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => !entry.__init);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new ApiError(500, "JSONL_READ_FAILED", `Failed to read JSONL file: ${filePath}`);
  }
}
