const NAME_POOL = [
  "david",
  "lucile",
  "max",
  "sarah",
  "leo",
  "ines",
  "nora",
  "adam",
  "jade",
  "yannis",
];

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateAgentName(seed = 0) {
  return NAME_POOL[seed % NAME_POOL.length];
}

function buildAgentId(name, role, collisionIndex = 0) {
  const base = `agent-${slugify(name) || "worker"}-${slugify(role) || "worker"}`;
  return collisionIndex > 0 ? `${base}-${collisionIndex + 1}` : base;
}

module.exports = {
  buildAgentId,
  generateAgentName,
  slugify,
};
