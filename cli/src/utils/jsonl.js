const fs = require("node:fs/promises");
const path = require("node:path");

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

module.exports = {
  appendJsonl,
  readJsonl,
};
