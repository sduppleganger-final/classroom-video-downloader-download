const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPreviewArgs,
  findStreamUrl,
  parsePreviewOutput
} = require("../src/videoPreview");

test("builds yt-dlp preview metadata arguments", () => {
  const args = buildPreviewArgs("https://example.com/video", {
    previewFormat: "best[height<=720]"
  });

  assert.deepEqual(args, [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--dump-single-json",
    "--format",
    "best[height<=720]",
    "https://example.com/video"
  ]);
});

test("parses preview metadata with a selected stream URL", () => {
  const preview = parsePreviewOutput(
    JSON.stringify({
      title: "Lecture demo",
      duration: 123,
      thumbnail: "https://cdn.example/thumb.jpg",
      url: "https://cdn.example/video.mp4",
      webpage_url: "https://example.com/watch"
    })
  );

  assert.equal(preview.title, "Lecture demo");
  assert.equal(preview.duration, 123);
  assert.equal(preview.thumbnail, "https://cdn.example/thumb.jpg");
  assert.equal(preview.streamUrl, "https://cdn.example/video.mp4");
  assert.equal(preview.webpageUrl, "https://example.com/watch");
});

test("finds stream URLs from requested downloads", () => {
  const streamUrl = findStreamUrl({
    requested_downloads: [
      {
        url: "https://cdn.example/requested.mp4"
      }
    ]
  });

  assert.equal(streamUrl, "https://cdn.example/requested.mp4");
});

test("throws when preview metadata has no stream URL", () => {
  assert.throws(() => parsePreviewOutput(JSON.stringify({ title: "No stream" })));
});
