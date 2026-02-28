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
const { detectDirectGoal } = require("../src/cli");

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
  config.providers.generic.command = "cat";
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

  process.env.AGENTSQUAD_AGENT_ID = agent.id;
  process.env.AGENTSQUAD_SESSION_ID = "default";

  const context = await getTaskContext(cwd, {});
  assert.equal(context.agent.id, agent.id);
  assert.equal(context.task.status, "todo");
  assert.match(context.task.description, /smoke test/i);

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
  config.providers.vibe = {
    command: "cat",
    args: [],
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

test("detectDirectGoal ignores provider shortcut commands", () => {
  assert.equal(detectDirectGoal(["node", "agentsquad", "vibe", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "codex", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "claude", "create a note app"]), null);
  assert.equal(detectDirectGoal(["node", "agentsquad", "create a note app"]), "create a note app");
});
