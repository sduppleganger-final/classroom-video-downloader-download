const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const ffmpeg = require("ffmpeg-static");
const {
  buildSourceSubtitleArgs,
  buildSubtitleFilter,
  createSourceSubtitleArtifacts,
  extractSubtitleLanguages,
  findDownloadedSubtitleFile,
  normalizeSourceSubtitleSelection,
  renderCaptionedVideo,
  srtToReadableText
} = require("../src/sourceSubtitles");

test("discovers manual and automatic source subtitle languages with manual tracks preferred", () => {
  const languages = extractSubtitleLanguages({
    subtitles: {
      en: [{ name: "English", ext: "vtt" }],
      he: [{ name: "Hebrew", ext: "srt" }]
    },
    automatic_captions: {
      en: [{ name: "English automatic", ext: "json3" }],
      fr: [{ name: "French\u0000 automatic", ext: "vtt" }],
      "../bad": [{ name: "Unsafe", ext: "vtt" }]
    }
  });

  assert.deepEqual(languages, [
    { code: "en", name: "English", source: "manual" },
    { code: "fr", name: "French automatic", source: "automatic" },
    { code: "he", name: "Hebrew", source: "manual" }
  ]);
});

test("validates source subtitle selection for video downloads", () => {
  assert.deepEqual(
    normalizeSourceSubtitleSelection(
      { enabled: true, language: "he-IL" },
      { downloadType: "video" }
    ),
    {
      ok: true,
      value: { enabled: true, language: "he-IL" }
    }
  );
  assert.equal(
    normalizeSourceSubtitleSelection(
      { enabled: true, language: "../../he" },
      { downloadType: "video" }
    ).ok,
    false
  );
  assert.equal(
    normalizeSourceSubtitleSelection(
      { enabled: true, language: "he" },
      { downloadType: "audio" }
    ).ok,
    false
  );
});

test("builds exact-language subtitle download and conversion arguments", () => {
  const args = buildSourceSubtitleArgs(
    { enabled: true, language: "en.US" },
    "%(title)s - 2026-07-23_23-00-00.%(ext)s",
    "C:\\tools\\ffmpeg.exe"
  );

  assert.deepEqual(args, [
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "^en\\.US$",
    "--sub-format",
    "srt/best",
    "--convert-subs",
    "srt",
    "--output",
    "subtitle:%(title)s - 2026-07-23_23-00-00.%(language)s.%(ext)s",
    "--ffmpeg-location",
    "C:\\tools\\ffmpeg.exe"
  ]);
});

test("converts timestamped SRT cues into a readable UTF-8 transcript", () => {
  const transcript = srtToReadableText(`\uFEFF1\r
00:00:00,000 --> 00:00:01,500\r
<i>Hello &amp; welcome</i>\r
\r
2\r
00:00:01,500 --> 00:00:03,000\r
Second line\r
continues here\r
\r
3\r
00:00:03,000 --> 00:00:04,000\r
Second line continues here\r
`);

  assert.equal(
    transcript,
    "Hello & welcome\n\nSecond line continues here\n"
  );
});

test("finds the selected subtitle belonging to the downloaded media", (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-source-subs-"));
  const mediaPath = path.join(downloadsDir, "Lecture - 2026-07-23_23-00-00.mp4");
  const selectedPath = path.join(
    downloadsDir,
    "Lecture - 2026-07-23_23-00-00.he.srt"
  );

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));
  fs.writeFileSync(mediaPath, "video");
  fs.writeFileSync(selectedPath, "subtitle");
  fs.writeFileSync(path.join(downloadsDir, "Other.en.srt"), "other");

  assert.equal(
    findDownloadedSubtitleFile({
      downloadsDir,
      mediaPath,
      language: "he",
      startedAtMs: Date.now() - 1000
    }),
    selectedPath
  );
});

test("renders a captioned video and returns timestamp-matched SRT and TXT artifacts", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-caption-render-"));
  const mediaPath = path.join(downloadsDir, "Lecture - 2026-07-23_23-00-00.mp4");
  const subtitlePath = path.join(
    downloadsDir,
    "Lecture - 2026-07-23_23-00-00.he.srt"
  );
  const progress = [];
  let rendererArgs = [];

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));
  fs.writeFileSync(mediaPath, "video");
  fs.writeFileSync(
    subtitlePath,
    "1\n00:00:00,000 --> 00:00:01,000\nשלום לכיתה\n",
    "utf8"
  );

  const result = await createSourceSubtitleArtifacts({
    downloadsDir,
    mediaPath,
    language: "he",
    width: 1600,
    height: 900,
    duration: 10,
    startedAtMs: Date.now() - 1000,
    ffmpegCommandParts: { command: "fake-ffmpeg", args: ["--fixture"] },
    spawnImpl: (_command, args) => {
      rendererArgs = args;
      const child = new EventEmitter();

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};

      process.nextTick(() => {
        fs.writeFileSync(args.at(-1), "captioned-video");
        child.stdout.emit("data", Buffer.from("out_time_ms=5000000\n"));
        child.emit("close", 0);
      });

      return child;
    },
    onProgress: (update) => progress.push(update)
  });

  assert.equal(
    result.fileName,
    "Lecture - 2026-07-23_23-00-00 - subtitled he.mp4"
  );
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "captioned-video");
  assert.deepEqual(
    result.artifacts.map((artifact) => [artifact.id, artifact.fileName]),
    [
      ["subtitles", "Lecture - 2026-07-23_23-00-00.he.srt"],
      ["transcript", "Lecture - 2026-07-23_23-00-00.he.txt"]
    ]
  );
  assert.equal(
    fs.readFileSync(result.artifacts[1].filePath, "utf8"),
    "שלום לכיתה\n"
  );
  assert.match(rendererArgs.join(" "), /Alignment=2,MarginV=24,FontSize=18/);
  assert.equal(progress.at(-1).percent, 99);
});

test("defers source subtitle rendering for an editable review session", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-source-review-"));
  const mediaPath = path.join(downloadsDir, "Lecture - 2026-07-24_10-00-00.mp4");
  const subtitlePath = path.join(
    downloadsDir,
    "Lecture - 2026-07-24_10-00-00.en.srt"
  );
  let rendererStarted = false;

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));
  fs.writeFileSync(mediaPath, "video");
  fs.writeFileSync(
    subtitlePath,
    "1\n00:00:00,000 --> 00:00:02,000\nEditable source cue\n",
    "utf8"
  );

  const result = await createSourceSubtitleArtifacts({
    downloadsDir,
    mediaPath,
    language: "en",
    width: 1280,
    height: 720,
    duration: 20,
    startedAtMs: Date.now() - 1000,
    deferRender: true,
    spawnImpl: () => {
      rendererStarted = true;
      throw new Error("rendering should be deferred");
    }
  });

  assert.equal(rendererStarted, false);
  assert.equal(result.filePath, mediaPath);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.review.mode, "source");
  assert.equal(result.review.subtitlePath, subtitlePath);
  assert.equal(fs.readFileSync(result.review.transcriptPath, "utf8"), "Editable source cue\n");
  assert.equal(result.review.artifacts.length, 2);
});

test("builds a bottom-centered libass subtitle filter by default", () => {
  const filter = buildSubtitleFilter("C:\\Videos\\lecture.srt", {
    marginV: 24,
    fontSize: 28
  });

  assert.match(filter, /^subtitles=filename='C\\:\/Videos\/lecture\.srt'/);
  assert.match(filter, /Alignment=2,MarginV=24,FontSize=28/);
});

test("bundled ffmpeg renders source subtitles at the bottom center", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-real-caption-"));
  const mediaPath = path.join(downloadsDir, "Position Test - 2026-07-23_23-10-00.mp4");
  const subtitlePath = path.join(
    downloadsDir,
    "Position Test - 2026-07-23_23-10-00.en.srt"
  );

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const fixtureResult = spawnSync(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:d=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mediaPath
    ],
    { encoding: "utf8" }
  );

  assert.equal(fixtureResult.status, 0, fixtureResult.stderr);
  fs.writeFileSync(
    subtitlePath,
    "1\n00:00:00,200 --> 00:00:02,800\nBOTTOM CENTER\n",
    "utf8"
  );

  const result = await createSourceSubtitleArtifacts({
    downloadsDir,
    mediaPath,
    language: "en",
    width: 640,
    height: 360,
    duration: 3,
    startedAtMs: Date.now() - 5000,
    ffmpegCommandParts: { command: ffmpeg, args: [] }
  });
  const frameResult = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      result.filePath,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1"
    ],
    { encoding: null, maxBuffer: 640 * 360 * 2 }
  );

  assert.equal(frameResult.status, 0, frameResult.stderr?.toString());

  const bounds = findLitPixelBounds(frameResult.stdout, 640, 360, 70);

  assert.ok(bounds.count > 100);
  assert.ok(bounds.minY >= 280 && bounds.maxY <= 345, JSON.stringify(bounds));
  assert.ok(
    Math.abs((bounds.minX + bounds.maxX) / 2 - 320) <= 25,
    JSON.stringify(bounds)
  );
});

test("bundled ffmpeg renders Whisper captions at the bottom center", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-bottom-caption-"));
  const mediaPath = path.join(downloadsDir, "bottom-position.mp4");
  const subtitlePath = path.join(downloadsDir, "bottom-position.en.srt");
  const outputPath = path.join(downloadsDir, "bottom-position-captioned.mp4");

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const fixtureResult = spawnSync(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:d=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mediaPath
    ],
    { encoding: "utf8" }
  );

  assert.equal(fixtureResult.status, 0, fixtureResult.stderr);
  fs.writeFileSync(
    subtitlePath,
    "1\n00:00:00,200 --> 00:00:02,800\nBOTTOM CENTER\n",
    "utf8"
  );

  await renderCaptionedVideo({
    inputPath: mediaPath,
    subtitlePath,
    outputPath,
    width: 640,
    height: 360,
    duration: 3,
    captionPosition: "bottom-center",
    ffmpegCommandParts: { command: ffmpeg, args: [] }
  });

  const frameResult = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1"
    ],
    { encoding: null, maxBuffer: 640 * 360 * 2 }
  );

  assert.equal(frameResult.status, 0, frameResult.stderr?.toString());

  const bounds = findLitPixelBounds(frameResult.stdout, 640, 360, 70);

  assert.ok(bounds.count > 100);
  assert.ok(bounds.minY >= 280 && bounds.maxY <= 345, JSON.stringify(bounds));
  assert.ok(
    Math.abs((bounds.minX + bounds.maxX) / 2 - 320) <= 25,
    JSON.stringify(bounds)
  );
});

test("bundled ffmpeg applies a custom top-left size and color", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-custom-caption-"));
  const mediaPath = path.join(downloadsDir, "custom-position.mp4");
  const subtitlePath = path.join(downloadsDir, "custom-position.en.srt");
  const outputPath = path.join(downloadsDir, "custom-position-captioned.mp4");

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const fixtureResult = spawnSync(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mediaPath
    ],
    { encoding: "utf8" }
  );

  assert.equal(fixtureResult.status, 0, fixtureResult.stderr);
  fs.writeFileSync(
    subtitlePath,
    "1\n00:00:00,100 --> 00:00:01,900\nCUSTOM CAPTION\n",
    "utf8"
  );

  await renderCaptionedVideo({
    inputPath: mediaPath,
    subtitlePath,
    outputPath,
    width: 640,
    height: 360,
    duration: 2,
    captionStyle: { position: "top-left", fontSize: 32, color: "#FFCC00" },
    ffmpegCommandParts: { command: ffmpeg, args: [] }
  });

  const frameResult = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1"
    ],
    { encoding: null, maxBuffer: 640 * 360 * 4 }
  );

  assert.equal(frameResult.status, 0, frameResult.stderr?.toString());

  const bounds = findYellowPixelBounds(frameResult.stdout, 640, 360);

  assert.ok(bounds.count > 100, JSON.stringify(bounds));
  assert.ok(bounds.minX >= 20 && bounds.minX < 100, JSON.stringify(bounds));
  assert.ok(bounds.maxX < 420, JSON.stringify(bounds));
  assert.ok(bounds.minY >= 15 && bounds.maxY < 100, JSON.stringify(bounds));
});

function findLitPixelBounds(pixels, width, height, threshold) {
  const bounds = {
    minX: width,
    maxX: -1,
    minY: height,
    maxY: -1,
    count: 0
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[y * width + x] <= threshold) {
        continue;
      }

      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.count += 1;
    }
  }

  return bounds;
}

function findYellowPixelBounds(pixels, width, height) {
  const bounds = {
    minX: width,
    maxX: -1,
    minY: height,
    maxY: -1,
    count: 0
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];

      if (red < 160 || green < 110 || blue > 100) {
        continue;
      }

      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.count += 1;
    }
  }

  return bounds;
}
