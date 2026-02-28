const path = require("node:path");
const { pathExists, readJsonFile, writeJsonFile } = require("./state");
const { AgentsquadError } = require("./errors");

function defaultConfig() {
  return {
    defaultSession: "default",
    providers: {
      codex: {
        command: "codex",
        args: ["exec"],
        mode: "oneshot",
        transport: "args",
        messageFormat: "plain",
        workingDirectoryMode: "inherit",
        env: {},
      },
      generic: {
        command: "cat",
        args: [],
        mode: "oneshot",
        transport: "stdin",
        messageFormat: "plain",
        workingDirectoryMode: "inherit",
        env: {},
      },
    },
  };
}

function getConfigPath(cwd) {
  return path.join(cwd, "agentsquad.config.json");
}

async function loadConfig(cwd) {
  const configPath = getConfigPath(cwd);
  const exists = await pathExists(configPath);
  if (!exists) {
    throw new AgentsquadError(
      "CONFIG_NOT_FOUND",
      `No agentsquad.config.json found in ${cwd}. Run "agentsquad init" first.`,
      1
    );
  }

  const config = await readJsonFile(configPath);
  validateConfig(config, configPath);
  return config;
}

function validateConfig(config, configPath = "agentsquad.config.json") {
  if (!config || typeof config !== "object") {
    throw new AgentsquadError("CONFIG_INVALID", `${configPath} must contain an object.`);
  }

  if (!config.providers || typeof config.providers !== "object") {
    throw new AgentsquadError("CONFIG_INVALID", `${configPath} must define a "providers" object.`);
  }
}

async function saveConfig(cwd, config) {
  validateConfig(config);
  await writeJsonFile(getConfigPath(cwd), config);
}

module.exports = {
  defaultConfig,
  getConfigPath,
  loadConfig,
  saveConfig,
  validateConfig,
};
