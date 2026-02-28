#!/usr/bin/env node

const { Command } = require("commander");

const program = new Command();

program
  .name("agentsquad")
  .description("CLI Agentsquad initialise avec commander")
  .version("1.0.0");

program
  .command("hello")
  .description("Affiche un message de bienvenue")
  .option("-n, --name <name>", "Nom a afficher", "AgentSquad")
  .action((options) => {
    console.log(`Bonjour ${options.name} !`);
  });

program
  .argument("[name]", "Nom facultatif pour un message rapide")
  .action((name) => {
    if (name) {
      console.log(`Bonjour ${name} !`);
      return;
    }

    program.outputHelp();
  });

program.parse();
