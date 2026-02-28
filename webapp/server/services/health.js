import { getAppConfig } from "../config/app";

export function getHealthStatus() {
  const config = getAppConfig();

  return {
    status: "ok",
    service: config.appName,
    version: config.version,
    environment: config.environment,
    timestamp: new Date().toISOString(),
  };
}
