const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { getAvailableDownloadPath } = require("../electron/downloadPath");

test("getAvailableDownloadPath saves inside the downloads directory", () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-downloads-"));

  try {
    const savePath = getAvailableDownloadPath(downloadsDir, "lesson.mp3");

    assert.equal(savePath, path.join(downloadsDir, "lesson.mp3"));
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("getAvailableDownloadPath avoids overwriting an existing file", () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-downloads-"));

  try {
    fs.writeFileSync(path.join(downloadsDir, "lesson.mp3"), "existing");

    const savePath = getAvailableDownloadPath(downloadsDir, "lesson.mp3");

    assert.equal(savePath, path.join(downloadsDir, "lesson (1).mp3"));
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("getAvailableDownloadPath strips folder components from file names", () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-downloads-"));

  try {
    const savePath = getAvailableDownloadPath(downloadsDir, "../lesson.mp3");

    assert.equal(savePath, path.join(downloadsDir, "lesson.mp3"));
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});
