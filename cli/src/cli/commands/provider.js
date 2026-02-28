const { loadConfig } = require("../../core/config");
const { resolveProviderStatuses } = require("../../providers/adapter-registry");
const { printOutput } = require("../../utils/output");

function registerProviderCommands(program) {
  const provider = program.command("provider").description("Inspect configured providers");

  provider
    .command("list")
    .description("List configured providers and local availability")
    .option("--json", "Return JSON output", false)
    .action(async (options) => {
      const config = await loadConfig(process.cwd());
      const providers = await resolveProviderStatuses(config);
      printOutput(options, {
        status: "ok",
        providers,
      }, (payload) => {
        if (!payload.providers.length) {
          return "No built-in providers available.";
        }

        return payload.providers
          .map((entry) => {
            const availability = entry.available ? "available" : "missing";
            return `${entry.id} (${availability}) -> ${entry.command}`;
          })
          .join("\n");
      });
    });
}

module.exports = {
  registerProviderCommands,
};
