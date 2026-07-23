const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildPreviewArgs,
  findStreamUrl,
  getVideoPreview,
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

test("retries preview metadata with a backup after an unsupported Python runtime", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-preview-fallback-"));
  const failedExtractor = path.join(fixtureRoot, "failed-extractor.js");
  const backupExtractor = path.join(fixtureRoot, "backup-extractor.js");

  fs.writeFileSync(
    failedExtractor,
    `console.error("ImportError: You are using an unsupported version of Python."); process.exit(1);`
  );
  fs.writeFileSync(
    backupExtractor,
    `console.log(JSON.stringify({ title: "Fallback preview", duration: 12, url: "https://cdn.example/video.mp4" }));`
  );

  try {
    const preview = await getVideoPreview(
      "https://example.com/video",
      { previewFormat: "best" },
      {
        commandCandidates: [
          {
            command: process.execPath,
            args: [failedExtractor],
            label: "Python-dependent extractor"
          },
          {
            command: process.execPath,
            args: [backupExtractor],
            label: "native backup extractor"
          }
        ]
      }
    );

    assert.equal(preview.title, "Fallback preview");
    assert.equal(preview.streamUrl, "https://cdn.example/video.mp4");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
