const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { defaultConfig } = require("../src/core/config");
const { writeJsonFile, readJsonFile, pathExists } = require("../src/core/state");
const { spawnAgent, showAgent } = require("../src/core/agents");
const { sendMessage, listMessages } = require("../src/core/messages");

test("spawnAgent creates a managed oneshot agent", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();

  await writeJsonFile(path.join(cwd, "agentsquad.config.json"), config);

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
  });

  assert.match(agent.id, /^agent-/);
  assert.equal(agent.status, "idle");

  const loaded = await showAgent(cwd, "default", agent.id);
  assert.equal(loaded.id, agent.id);
});

test("sendMessage persists and delivers a oneshot message", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentsquad-"));
  const config = defaultConfig();
  config.providers.generic.command = "cat";
  config.providers.generic.transport = "stdin";

  await writeJsonFile(path.join(cwd, "agentsquad.config.json"), config);

  const agent = await spawnAgent(cwd, config, {
    provider: "generic",
    session: "default",
    workdir: cwd,
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
