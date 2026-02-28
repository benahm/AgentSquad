export function getAppConfig() {
  return {
    appName: "AgentSquad Webapp",
    version: "0.1.0",
    environment: process.env.NODE_ENV || "development",
  };
}
