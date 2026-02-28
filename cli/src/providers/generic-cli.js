const path = require("node:path");
const fs = require("node:fs/promises");
const { runOneshotProcess } = require("../core/process-manager");

function createGenericCliAdapter(providerId) {
  return {
    providerId,
    createSpawnInvocation(agent, providerConfig) {
      return {
        command: providerConfig.command,
        args: providerConfig.args || [],
        cwd: resolveCwd(agent, providerConfig),
        env: buildEnv(agent, providerConfig),
      };
    },

    async deliverMessage(agent, providerConfig, message, workspace) {
      const invocation = await buildMessageInvocation(agent, providerConfig, message, workspace);
      const result = await runOneshotProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdoutPath: workspace.stdoutPath,
        stderrPath: workspace.stderrPath,
        stdinText: invocation.stdinText,
      });

      return {
        ok: result.code === 0,
        code: result.code,
        signal: result.signal || null,
        transport: providerConfig.transport || "stdin",
      };
    },
  };
}

async function buildMessageInvocation(agent, providerConfig, message, workspace) {
  const base = {
    command: providerConfig.command,
    args: [...(providerConfig.args || [])],
    cwd: resolveCwd(agent, providerConfig),
    env: buildEnv(agent, providerConfig),
    stdinText: undefined,
  };

  const payload = formatMessage(message);

  switch (providerConfig.transport) {
    case "args":
      base.args.push(payload);
      break;
    case "file":
      if (providerConfig.messageFileFlag) {
        const payloadPath = path.join(workspace.root, `${message.id}.txt`);
        await fs.writeFile(payloadPath, payload, "utf8");
        base.args.push(providerConfig.messageFileFlag, payloadPath);
      } else {
        base.args.push(payload);
      }
      break;
    case "stdin":
    default:
      base.stdinText = payload;
      break;
  }

  return base;
}

function buildEnv(agent, providerConfig) {
  return {
    ...process.env,
    ...(providerConfig.env || {}),
    ...(agent.env || {}),
    AGENTSQUAD_AGENT_ID: agent.id,
    AGENTSQUAD_SESSION_ID: agent.sessionId,
  };
}

function resolveCwd(agent, providerConfig) {
  if (providerConfig.workingDirectoryMode === "fixed" && providerConfig.cwd) {
    return path.resolve(providerConfig.cwd);
  }

  return agent.workdir;
}

function formatMessage(message) {
  return [
    "[message]",
    `id: ${message.id}`,
    `from: ${message.from || "user"}`,
    `to: ${message.to}`,
    `session: ${message.sessionId}`,
    "",
    message.text,
    "",
  ].join("\n");
}

module.exports = {
  createGenericCliAdapter,
};
