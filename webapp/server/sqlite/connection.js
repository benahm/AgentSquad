import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { ApiError } from "@/server/http/errors";

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

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

export async function normalizeAndValidateDatabasePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new ApiError(400, "INVALID_DB_PATH", "A SQLite database path is required.");
  }

  const dbPath = normalizeInputPath(inputPath);

  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) {
      throw new ApiError(400, "INVALID_DB_PATH", "The SQLite path must point to a file.");
    }
    await fs.access(dbPath, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "INVALID_DB_PATH", `Unable to read SQLite database at "${dbPath}".`);
  }

  return dbPath;
}

async function syncReadableMirror(dbPath) {
  const mirrorRoot = path.join(os.tmpdir(), "agentsquad-webapp");
  const mirrorId = crypto.createHash("sha1").update(dbPath).digest("hex");

  await fs.mkdir(mirrorRoot, { recursive: true });

  // Use a unique temp directory per invocation to avoid EBUSY when another
  // connection still has an older mirror open on Windows.
  const mirrorDir = await fs.mkdtemp(path.join(mirrorRoot, `${mirrorId}-`));
  const mirrorPath = path.join(mirrorDir, "agentsquad.db");

  await fs.copyFile(dbPath, mirrorPath);

  for (const suffix of ["-wal", "-shm"]) {
    const sourceSidecar = `${dbPath}${suffix}`;
    const mirrorSidecar = `${mirrorPath}${suffix}`;

    try {
      await fs.copyFile(sourceSidecar, mirrorSidecar);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return { mirrorPath, mirrorDir };
}

export async function withReadOnlyDatabase(dbPath, callback) {
  let db;
  let mirrorDir;

  try {
    const { mirrorPath, mirrorDir: createdMirrorDir } = await syncReadableMirror(dbPath);
    mirrorDir = createdMirrorDir;

    db = new Database(mirrorPath, {
      readonly: true,
    });
    db.prepare("PRAGMA query_only = 1").run();
    db.prepare(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).run();
    return callback(db);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = String(error?.message || "");

    if (message.includes("SQLITE_BUSY") || message.includes("database is locked") || message.includes("database is busy")) {
      throw new ApiError(503, "SQLITE_BUSY", "The SQLite database is busy. Please retry.");
    }

    throw new ApiError(500, "SQLITE_READ_FAILED", `Failed to read SQLite database: ${message}`);
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures on read-only connections.
    }

    if (mirrorDir) {
      try {
        await fs.rm(mirrorDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore failures.
      }
    }
  }
}
