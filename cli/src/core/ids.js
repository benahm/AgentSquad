const { randomUUID } = require("node:crypto");

function createId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

module.exports = {
  createId,
};
