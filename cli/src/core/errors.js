class AgentsquadError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "AgentsquadError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function assert(condition, code, message, exitCode) {
  if (!condition) {
    throw new AgentsquadError(code, message, exitCode);
  }
}

module.exports = {
  AgentsquadError,
  assert,
};
