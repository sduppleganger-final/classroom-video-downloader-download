const fs = require("fs");

function resolvePackagedBinaryPath(filePath) {
  if (!filePath) {
    return "";
  }

  if (fs.existsSync(filePath)) {
    return filePath;
  }

  const unpackedPath = filePath.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");

  return fs.existsSync(unpackedPath) ? unpackedPath : filePath;
}

module.exports = {
  resolvePackagedBinaryPath
};
