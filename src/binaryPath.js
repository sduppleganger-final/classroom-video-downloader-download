const fs = require("fs");

function resolvePackagedBinaryPath(filePath) {
  if (!filePath) {
    return "";
  }

  // Electron's patched fs reports files inside app.asar as existing, but the OS
  // cannot execute them. Prefer the real unpacked copy before checking that path.
  const preferredUnpackedPath = filePath.replace(
    /app\.asar(?=[\\/])/,
    "app.asar.unpacked"
  );

  if (preferredUnpackedPath !== filePath && fs.existsSync(preferredUnpackedPath)) {
    return preferredUnpackedPath;
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
