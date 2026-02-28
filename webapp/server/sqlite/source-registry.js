import path from "node:path";

const registry = globalThis.__agentsquadSourceRegistry || new Map();
globalThis.__agentsquadSourceRegistry = registry;

function createSourceId() {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function registerDataSource(dbPath, detectedTables) {
  const normalizedPath = path.resolve(dbPath);
  const existing = [...registry.values()].find((entry) => entry.dbPath === normalizedPath);

  if (existing) {
    existing.detectedTables = detectedTables;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  const source = {
    id: createSourceId(),
    dbPath: normalizedPath,
    schema: "agentsquad",
    detectedTables,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  registry.set(source.id, source);
  return source;
}

export function getDataSource(sourceId) {
  return registry.get(sourceId) || null;
}

