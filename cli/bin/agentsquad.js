#!/usr/bin/env node

const { run } = require("../src/cli");

run(process.argv).catch((error) => {
  const message = error && error.message ? error.message : "Unexpected error";
  console.error(message);
  process.exitCode = error && typeof error.exitCode === "number" ? error.exitCode : 1;
});
