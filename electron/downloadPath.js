const fs = require("fs");
const path = require("path");

function getAvailableDownloadPath(downloadsDir, fileName) {
  const safeFileName = path.basename(fileName || "download");
  const preferredPath = path.join(downloadsDir, safeFileName || "download");

  if (!fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  const extension = path.extname(preferredPath);
  const stem = path.basename(preferredPath, extension);
  const directory = path.dirname(preferredPath);

  for (let index = 1; index < 1000; index += 1) {
    const candidatePath = path.join(directory, `${stem} (${index})${extension}`);

    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return path.join(directory, `${stem} - ${Date.now()}${extension}`);
}

module.exports = { getAvailableDownloadPath };
