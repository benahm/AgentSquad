const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { pathExists, writeJsonFile, readJsonFile } = require("./state");

async function startDetachedProcess(command, args, options) {
  const stdoutFd = fs.openSync(options.stdoutPath, "a");
  const stderrFd = fs.openSync(options.stderrPath, "a");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });

  child.unref();

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  await writeJsonFile(options.pidPath, {
    pid: child.pid,
    command,
    args,
    startedAt: new Date().toISOString(),
  });

  return child.pid;
}

async function runOneshotProcess(command, args, options) {
  const stdoutStream = fs.createWriteStream(options.stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(options.stderrPath, { flags: "a" });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    if (options.stdinText) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();

    child.on("close", (code, signal) => {
      stdoutStream.end();
      stderrStream.end();
      resolve({
        code,
        signal,
      });
    });
  });
}

async function readPid(pidPath) {
  if (!(await pathExists(pidPath))) {
    return null;
  }

  return readJsonFile(pidPath);
}

function isPidAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pidPath) {
  const metadata = await readPid(pidPath);
  if (!metadata || !metadata.pid) {
    return {
      stopped: false,
      pid: null,
    };
  }

  if (!isPidAlive(metadata.pid)) {
    return {
      stopped: false,
      pid: metadata.pid,
    };
  }

  process.kill(metadata.pid, "SIGTERM");
  await fsp.rm(pidPath, { force: true });

  return {
    stopped: true,
    pid: metadata.pid,
  };
}

module.exports = {
  isPidAlive,
  readPid,
  runOneshotProcess,
  startDetachedProcess,
  stopPid,
};
