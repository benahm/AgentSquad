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
        onStdout: invocation.onStdout,
        onStderr: invocation.onStderr,
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
    onStdout: null,
    onStderr: null,
  };

  const payload = formatMessage(message);
  base.onStdout = (line) => {
    if (typeof message.onStdout === "function") {
      message.onStdout(line);
    }
  };
  base.onStderr = (line) => {
    if (typeof message.onStderr === "function") {
      message.onStderr(line);
    }
  };

  switch (providerConfig.transport) {
    case "args":
      if (providerConfig.promptFlag) {
        base.args.push(providerConfig.promptFlag, payload);
      } else {
        base.args.push(payload);
      }
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
    AGENTSQUAD_AGENT_ROLE: agent.role || "",
    AGENTSQUAD_TASK_ID: agent.currentTaskId || "",
    AGENTSQUAD_WORKSPACE_ROOT: (agent.env && agent.env.AGENTSQUAD_WORKSPACE_ROOT) || process.env.AGENTSQUAD_WORKSPACE_ROOT || "",
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
