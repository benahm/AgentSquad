function printOutput(options, payload, formatter) {
  if (options && options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (formatter) {
    process.stdout.write(`${formatter(payload)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

module.exports = {
  printOutput,
};
