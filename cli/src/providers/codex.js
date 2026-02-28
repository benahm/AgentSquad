const { createGenericCliAdapter } = require("./generic-cli");

function createCodexAdapter() {
  return createGenericCliAdapter("codex");
}

module.exports = {
  createCodexAdapter,
};
