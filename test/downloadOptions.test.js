const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResolution, resolutionOptions } = require("../src/downloadOptions");

test("defaults to best available resolution", () => {
  const result = normalizeResolution(undefined);

  assert.equal(result.ok, true);
  assert.equal(result.value, "best");
  assert.equal(result.label, "Best available");
  assert.equal(result.format.includes("height<="), false);
  assert.equal(result.previewFormat.includes("vcodec!=none"), true);
});

test("accepts supported maximum resolutions", () => {
  const result = normalizeResolution("720");

  assert.equal(result.ok, true);
  assert.equal(result.value, "720");
  assert.equal(result.label, "720p or lower");
  assert.equal(result.height, 720);
  assert.equal(result.format.includes("height<=720"), true);
  assert.equal(result.format.includes("width<=720"), true);
  assert.equal(result.format.endsWith("best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best[ext=mp4]/best"), true);
  assert.equal(result.previewFormat.includes("height<=720"), true);
  assert.equal(result.previewFormat.includes("width<=720"), true);
  assert.equal(result.previewFormat.endsWith("best[ext=mp4][vcodec!=none]/best[vcodec!=none]/best[ext=mp4]/best"), true);
});

test("accepts MP3 as an audio-only download option", () => {
  const result = normalizeResolution("mp3");

  assert.equal(result.ok, true);
  assert.equal(result.value, "mp3");
  assert.equal(result.label, "MP3 audio only");
  assert.equal(result.downloadType, "audio");
  assert.equal(result.height, null);
  assert.equal(result.audioFormat, "mp3");
  assert.equal(result.format, "bestaudio/best");
  assert.equal(result.previewFormat.includes("vcodec!=none"), true);
});

test("rejects unsupported resolutions", () => {
  const result = normalizeResolution("1440");

  assert.equal(result.ok, false);
  assert.equal(result.message, "Choose a supported resolution.");
});

test("keeps the UI option values in the supported option set", () => {
  const values = resolutionOptions.map((option) => option.value);

  assert.deepEqual(values, ["best", "1080", "720", "480", "360", "mp3"]);
});
