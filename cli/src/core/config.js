const { AgentsquadError } = require("./errors");

function defaultConfig() {
  return {
    defaultSession: "default",
    orchestrator: {
      provider: "vibe",
      managerRoleName: "planner",
      autoNames: true,
    },
    providers: {
      vibe: {
        command: "vibe",
        args: [],
        mode: "oneshot",
        transport: "args",
        promptFlag: "--prompt",
        messageFormat: "plain",
        workingDirectoryMode: "inherit",
        env: {},
      },
      "mistral-vibe": {
        command: "vibe",
        args: [],
        mode: "oneshot",
        transport: "args",
        promptFlag: "--prompt",
        messageFormat: "plain",
        workingDirectoryMode: "inherit",
        env: {},
      },
      codex: {
        command: "codex",
        args: ["exec"],
        mode: "oneshot",
        transport: "args",
        messageFormat: "plain",
        workingDirectoryMode: "inherit",
        env: {},
      },
      claude: {
        command: "claude",
        args: [],
        mode: "oneshot",
        transport: "args",
        promptFlag: "--print",
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

async function loadConfig() {
  const config = defaultConfig();
  validateConfig(config, "built-in config");
  return config;
}

function validateConfig(config, configPath = "built-in config") {
  if (!config || typeof config !== "object") {
    throw new AgentsquadError("CONFIG_INVALID", `${configPath} must contain an object.`);
  }

  if (!config.providers || typeof config.providers !== "object") {
    throw new AgentsquadError("CONFIG_INVALID", `${configPath} must define a "providers" object.`);
  }

  if (!config.orchestrator || typeof config.orchestrator !== "object") {
    config.orchestrator = {
      provider: "vibe",
      managerRoleName: "planner",
      autoNames: true,
    };
  }
}

module.exports = {
  defaultConfig,
  loadConfig,
  validateConfig,
};
