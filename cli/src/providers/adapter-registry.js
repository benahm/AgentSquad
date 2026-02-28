const { spawnSync } = require("node:child_process");
const { AgentsquadError } = require("../core/errors");
const { createGenericCliAdapter } = require("./generic-cli");
const { createCodexAdapter } = require("./codex");

const PROVIDERS = {
  codex: createCodexAdapter(),
  vibe: createGenericCliAdapter("vibe"),
  claude: createGenericCliAdapter("claude"),
  "mistral-vibe": createGenericCliAdapter("mistral-vibe"),
  generic: createGenericCliAdapter("generic"),
};

function resolveProvider(providerId) {
  return PROVIDERS[providerId] || createGenericCliAdapter(providerId);
}

function mergeProviderConfig(config, providerId, profileName) {
  const provider = config.providers && config.providers[providerId];
  if (!provider) {
    throw new AgentsquadError("PROVIDER_UNKNOWN", `Provider "${providerId}" is not configured.`);
  }

  const profile = profileName && provider.profiles ? provider.profiles[profileName] : null;
  if (profileName && !profile) {
    throw new AgentsquadError("PROFILE_UNKNOWN", `Profile "${profileName}" is not configured for "${providerId}".`);
  }

  return {
    ...provider,
    args: [...(provider.args || []), ...(profile && profile.args ? profile.args : [])],
    env: {
      ...(provider.env || {}),
      ...((profile && profile.env) || {}),
    },
    cwd: (profile && profile.cwd) || provider.cwd,
  };
}

async function resolveProviderStatuses(config) {
  return Object.entries(config.providers || {}).map(([id, provider]) => {
    const available = commandExists(provider.command);
    return {
      id,
      command: provider.command,
      mode: provider.mode || "oneshot",
      transport: provider.transport || "stdin",
      available,
    };
  });
}

function commandExists(command) {
  const result = spawnSync("which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

module.exports = {
  mergeProviderConfig,
  resolveProvider,
  resolveProviderStatuses,
};
