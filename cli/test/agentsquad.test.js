const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { defaultConfig } = require("../src/core/config");
const { pathExists } = require("../src/core/state");
const { spawnAgent, showAgent } = require("../src/core/agents");
const { sendMessage, listMessages } = require("../src/core/messages");
const { getTaskContext, updateTaskStatus } = require("../src/core/tasks");
const { executeObjective } = require("../src/core/orchestrator");
const { runOneshotProcess } = require("../src/core/process-manager");
const { detectDirectGoal } = require("../src/cli");
const { listActivityLogs } = require("../src/core/activity-logs");

async function createEchoStdinCommand(cwd, filename = "echo-stdin.js") {
  const scriptPath = path.join(cwd, filename);
  await fs.writeFile(scriptPath, "process.stdin.pipe(process.stdout);", "utf8");
  return { command: process.execPath, args: [scriptPath] };
}

test("spawnAgent creates a managed oneshot agent", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
    role: "developer",
    goal: "Build the feature",
    task: "Create the first draft",
  });

  assert.match(agent.id, /^agent-[a-z]+-developer/);
  assert.equal(agent.status, "idle");
  assert.equal(agent.role, "developer");

  const loaded = await showAgent(cwd, "default", agent.id);
  assert.equal(loaded.id, agent.id);
});

test("sendMessage persists and delivers a oneshot message", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();
  const echo = await createEchoStdinCommand(cwd);
  config.providers.generic.command = echo.command;
  config.providers.generic.args = echo.args;
  config.providers.generic.transport = "stdin";

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
    role: "developer",
    goal: "Build the feature",
    task: "Create the first draft",
  });

  const result = await sendMessage(cwd, config, {
    session: "default",
    to: agent.id,
    text: "hello team",
  });

  assert.equal(result.message.deliveryStatus, "delivered");

  const messages = await listMessages(cwd, { session: "default" });
  assert.equal(messages.length, 1);

  const stdoutPath = path.join(cwd, ".agentsquad", "sessions", "default", "agents", agent.id, "stdout.log");
  assert.equal(await pathExists(stdoutPath), true);
  const stdout = await fs.readFile(stdoutPath, "utf8");
  assert.match(stdout, /hello team/);
});

test("task get resolves the current task from agent env", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
    role: "tester",
    goal: "Validate the app",
    task: "Write a smoke test plan",
  });

  await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
    role: "developer",
    goal: "Build the app",
    task: "Implement the note editor",
  });

  process.env.AGENTSQUAD_AGENT_ID = agent.id;
  process.env.AGENTSQUAD_SESSION_ID = "default";

  const context = await getTaskContext(cwd, {});
  assert.equal(context.agent.id, agent.id);
  assert.equal(context.task.status, "todo");
  assert.match(context.task.description, /smoke test/i);
  assert.equal(context.task.availableAgents.length, 1);
  assert.equal(context.task.availableAgents[0].role, "developer");
  assert.match(context.task.availableAgents[0].taskTitle, /note editor/i);

  await updateTaskStatus(cwd, {
    task: context.task.id,
    status: "in_progress",
    agent: agent.id,
    session: "default",
  });

  const updated = await getTaskContext(cwd, {});
  assert.equal(updated.task.status, "in_progress");

  delete process.env.AGENTSQUAD_AGENT_ID;
  delete process.env.AGENTSQUAD_SESSION_ID;
});

test("executeObjective creates a planner agent and initial message", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();
  const echo = await createEchoStdinCommand(cwd, "echo-planner.js");
  config.providers.vibe = {
    command: echo.command,
    args: echo.args,
    mode: "oneshot",
    transport: "stdin",
    messageFormat: "plain",
    workingDirectoryMode: "inherit",
    env: {},
  };

  const result = await executeObjective(cwd, config, {
    goal: "creer moi une todo app",
    session: "default",
    provider: "vibe",
    workdir: cwd,
  });

  assert.equal(result.manager.role, "planner");
  assert.match(result.manager.id, /^agent-manager-planner/);

  const messages = await listMessages(cwd, { session: "default" });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /project manager and planner/i);
  assert.match(messages[0].text, /provider "vibe"/i);
  assert.ok(!/codex/i.test(messages[0].text));
  assert.ok(!/claude/i.test(messages[0].text));

  const logs = await listActivityLogs(cwd, { session: "default" });
  assert.ok(logs.length >= 3);
  assert.match(logs[0].message, /planner started: planning/i);
});

test("executeObjective reuses the existing planner in the same session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();
  const echo = await createEchoStdinCommand(cwd, "echo-reuse-planner.js");
  config.providers.vibe = {
    command: echo.command,
    args: echo.args,
    mode: "oneshot",
    transport: "stdin",
    messageFormat: "plain",
    workingDirectoryMode: "inherit",
    env: {},
  };

  const first = await executeObjective(cwd, config, {
    goal: "creer moi une todo app",
    session: "default",
    provider: "vibe",
    workdir: cwd,
  });
  const second = await executeObjective(cwd, config, {
    goal: "creer moi une todo app",
    session: "default",
    provider: "vibe",
    workdir: cwd,
  });

  assert.equal(second.manager.id, first.manager.id);
  assert.equal(second.message, null);

  const agents = await showAgent(cwd, "default", first.manager.id);
  assert.equal(agents.id, first.manager.id);

  const messages = await listMessages(cwd, { session: "default" });
  assert.equal(messages.length, 1);
});

test("vibe provider sends the prompt through --prompt", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const scriptPath = path.join(cwd, "echo-args.js");
  const config = defaultConfig();

  await fs.writeFile(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.AGENTSQUAD_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"),
    "utf8"
  );

  config.providers.vibe = {
    command: "node",
    args: [scriptPath],
    mode: "oneshot",
    transport: "args",
    promptFlag: "--prompt",
    messageFormat: "plain",
    workingDirectoryMode: "inherit",
    env: {
      AGENTSQUAD_CAPTURE_PATH: path.join(cwd, "captured.json"),
    },
  };

  await executeObjective(cwd, config, {
    goal: "create a note app",
    session: "default",
    provider: "vibe",
    workdir: cwd,
  });

  const captured = JSON.parse(await fs.readFile(path.join(cwd, "captured.json"), "utf8"));
  assert.equal(captured[0], "--prompt");
  assert.match(captured[1], /create a note app/i);
  assert.match(captured[1], /agentsquad task get/i);
});

test("runOneshotProcess waits for async stderr handlers", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const scriptPath = path.join(cwd, "stderr-burst.js");
  const seen = [];

  await fs.writeFile(
    scriptPath,
    [
      "console.error('first');",
      "console.error('second');",
      "console.error('third');",
    ].join("\n"),
    "utf8"
  );

  const result = await runOneshotProcess(process.execPath, [scriptPath], {
    cwd,
    env: process.env,
    stdoutPath: path.join(cwd, "stdout.log"),
    stderrPath: path.join(cwd, "stderr.log"),
    onStderr: async (line) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(line);
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("sendMessage flushes streamed stderr logs after delivery", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const scriptPath = path.join(cwd, "stderr-provider.js");
  const config = defaultConfig();

  await fs.writeFile(
    scriptPath,
    [
      "console.error('alpha');",
      "console.error('beta');",
    ].join("\n"),
    "utf8"
  );

  config.providers.generic = {
    command: process.execPath,
    args: [scriptPath],
    mode: "oneshot",
    transport: "args",
    messageFormat: "plain",
    workingDirectoryMode: "inherit",
    env: {},
  };

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
    role: "developer",
    goal: "Build the feature",
    task: "Create the first draft",
  });

  await sendMessage(cwd, config, {
    session: "default",
    to: agent.id,
    text: "hello team",
  });

  const logs = await listActivityLogs(cwd, { session: "default" });
  const stderrLogs = logs.filter((entry) => entry.kind === "agent.stderr");
  assert.equal(stderrLogs.length, 2);
  assert.match(stderrLogs[0].message, /alpha/);
  assert.match(stderrLogs[1].message, /beta/);
});

test("sendMessage reports a clearer Codex failure reason", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const scriptPath = path.join(cwd, "codex-failure.js");
  const config = defaultConfig();
  const reported = [];

  await fs.writeFile(
    scriptPath,
    [
      "console.error('ParserError');",
      "console.error('Le jeton « && » n’est pas un séparateur d\\'instruction valide.');",
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );

  config.providers.codex = {
    command: process.execPath,
    args: [scriptPath],
    mode: "oneshot",
    transport: "args",
    messageFormat: "plain",
    workingDirectoryMode: "inherit",
    env: {},
  };

  const agent = await spawnAgent(cwd, config, {
    provider: "codex",
    session: "default",
    workdir: cwd,
    role: "planner",
    goal: "Plan the project",
    task: "Create a plan",
    name: "manager",
    kind: "manager",
  });

  const result = await sendMessage(cwd, config, {
    session: "default",
    to: agent.id,
    text: "hello team",
    reporter: (line) => reported.push(line),
  });

  assert.equal(result.message.deliveryStatus, "failed");
  assert.ok(reported.some((line) => line.includes(`${agent.id} log: ParserError`)));
  assert.ok(reported.some((line) => line.includes("failure reason: Likely cause: Codex ran a PowerShell command with `&&`")));
});

test("detectDirectGoal ignores provider shortcut commands", () => {
  assert.equal(detectDirectGoal(["node", "agentsquad", "vibe", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "codex", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "claude", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "create a note app"]), "create a note app");
});
