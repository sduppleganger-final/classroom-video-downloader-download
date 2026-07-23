const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDownloadOutputTemplate,
  formatDownloadTimestamp
} = require("../src/fileNaming");

test("formats a local timestamp for Windows-safe filenames", () => {
  const timestamp = formatDownloadTimestamp(new Date(2026, 5, 26, 9, 7, 3));

  assert.equal(timestamp, "2026-06-26_09-07-03");
});

test("builds a yt-dlp template from original title plus download timestamp", () => {
  const template = buildDownloadOutputTemplate(new Date(2026, 5, 26, 9, 7, 3));

  assert.equal(template, "%(title)s - 2026-06-26_09-07-03.%(ext)s");
});
