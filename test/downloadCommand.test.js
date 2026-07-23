const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildAudioPostProcessArgs,
  buildDownloadArgs,
  getBundledFfmpegPath,
  getBundledYtDlpPath,
  getFfmpegLocation,
  getYtDlpExecutablePath,
  hasYtDlp,
  hasFfmpeg,
  buildActualResolutionLabel,
  buildResolutionAdjustmentMessage,
  downloadVideo,
  mapYtDlpError,
  parseYtDlpPrintOutput,
  parseYtDlpProgressOutput,
  resolveDownloadedFilePath
} = require("../server");

test("maps source subtitle throttling and stale-track failures clearly", () => {
  const sourceSubtitle = { enabled: true, language: "iw" };

  assert.deepEqual(
    mapYtDlpError("HTTP Error 429: Too Many Requests", { sourceSubtitle }),
    {
      statusCode: 503,
      userMessage:
        "The platform temporarily limited access to its subtitle track. Wait a few minutes and try again."
    }
  );
  assert.deepEqual(
    mapYtDlpError("Unable to download video subtitles for 'iw'", {
      sourceSubtitle
    }),
    {
      statusCode: 409,
      userMessage:
        "The selected source subtitle track is no longer available. Refresh the preview and choose an available language."
    }
  );
});

test("builds regular video download arguments without audio extraction", () => {
  const args = buildDownloadArgs(
    "https://example.com/video",
    {
      downloadType: "video",
      format: "best"
    },
    "downloads"
  );

  assert.equal(args.includes("--extract-audio"), false);
  assert.equal(args.includes("--audio-format"), false);
});

test("builds MP3 audio-only extraction arguments", () => {
  const args = buildAudioPostProcessArgs({
    downloadType: "audio",
    audioFormat: "mp3",
    audioQuality: "0"
  });

  assert.equal(args.includes("--extract-audio"), true);
  assert.equal(args.includes("--audio-format"), true);
  assert.equal(args.includes("mp3"), true);
  assert.equal(args.includes("--audio-quality"), true);
  assert.equal(args.includes("0"), true);
});

test("includes MP3 extraction in yt-dlp download arguments", () => {
  const args = buildDownloadArgs(
    "https://example.com/video",
    {
      downloadType: "audio",
      audioFormat: "mp3",
      audioQuality: "0",
      format: "bestaudio/best"
    },
    "downloads"
  );

  assert.equal(args.includes("--extract-audio"), true);
  assert.equal(args.includes("--audio-format"), true);
  assert.equal(args.includes("mp3"), true);
  assert.equal(args.includes("bestaudio/best"), true);
});

test("prints marked metadata for downloaded file and resolution", () => {
  const args = buildDownloadArgs(
    "https://example.com/video",
    {
      downloadType: "video",
      format: "best"
    },
    "downloads"
  );

  assert.equal(args.includes("after_move:__CVD_FILE__%(filepath)s"), true);
  assert.equal(args.includes("after_move:__CVD_WIDTH__%(width)s"), true);
  assert.equal(args.includes("after_move:__CVD_HEIGHT__%(height)s"), true);
  assert.equal(args.includes("after_move:__CVD_DURATION__%(duration)s"), true);
});

test("includes one selected source subtitle language and timestamp-matched SRT output", () => {
  const args = buildDownloadArgs(
    "https://example.com/video",
    {
      downloadType: "video",
      format: "best"
    },
    "downloads",
    {
      enabled: true,
      language: "he"
    }
  );

  assert.equal(args.includes("--write-subs"), true);
  assert.equal(args.includes("--write-auto-subs"), true);
  assert.equal(args.includes("^he$"), true);
  assert.equal(args.includes("--convert-subs"), true);
  assert.equal(args.includes("srt"), true);
  assert.equal(
    args.some(
      (value) =>
        typeof value === "string" &&
        value.startsWith("subtitle:%(title)s - ") &&
        value.endsWith(".%(language)s.%(ext)s")
    ),
    true
  );
});

test("prints marked progress updates while downloading", () => {
  const args = buildDownloadArgs(
    "https://example.com/video",
    {
      downloadType: "video",
      format: "best"
    },
    "downloads"
  );

  assert.equal(args.includes("--progress"), true);
  assert.equal(args.includes("--newline"), true);
  assert.equal(
    args.includes("download:__CVD_PROGRESS__%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.eta)s"),
    true
  );
});

test("parses yt-dlp marked print output", () => {
  const parsed = parseYtDlpPrintOutput(
    [
      "__CVD_FILE__C:\\\\Downloads\\\\lesson.mp4",
      "__CVD_WIDTH__1280",
      "__CVD_HEIGHT__720",
      "__CVD_DURATION__123.5"
    ].join("\\n")
  );

  assert.equal(parsed.filePath, "C:\\\\Downloads\\\\lesson.mp4");
  assert.equal(parsed.width, 1280);
  assert.equal(parsed.height, 720);
  assert.equal(parsed.duration, 123.5);
});

test("parses yt-dlp marked progress output", () => {
  const parsed = parseYtDlpProgressOutput("__CVD_PROGRESS__ 42.5%|4456448|10485760|12");

  assert.equal(Math.round(parsed.percent), 43);
  assert.equal(parsed.stage, "downloading");
  assert.match(parsed.message, /43%|42%/);
  assert.match(parsed.message, /4\.[0-9] MB/);
  assert.match(parsed.message, /10 MB/);
  assert.match(parsed.message, /12s remaining/);
});

test("builds resolution adjustment message when requested resolution is too high", () => {
  const message = buildResolutionAdjustmentMessage(
    {
      downloadType: "video",
      height: 1080
    },
    {
      width: 1280,
      height: 720
    }
  );

  assert.equal(
    message,
    "1080p was not available. Downloaded the highest available resolution instead: 720p."
  );
  assert.equal(buildActualResolutionLabel({ width: 1280, height: 720 }), "720p");
});

test("uses the short side as effective resolution for vertical videos", () => {
  const message = buildResolutionAdjustmentMessage(
    {
      downloadType: "video",
      height: 360
    },
    {
      width: 360,
      height: 640
    }
  );

  assert.equal(message, null);
  assert.equal(buildActualResolutionLabel({ width: 360, height: 640 }), "360p");
});

test("finds a bundled ffmpeg binary for local MP3 conversion", () => {
  const bundledPath = getBundledFfmpegPath();

  assert.equal(typeof bundledPath, "string");
  assert.notEqual(bundledPath, "");
  assert.equal(getFfmpegLocation().endsWith("ffmpeg.exe") || getFfmpegLocation().includes("ffmpeg"), true);
  assert.equal(hasFfmpeg(), true);
});

test("finds a bundled yt-dlp binary so Python is not required", () => {
  const bundledPath = getBundledYtDlpPath();

  assert.equal(typeof bundledPath, "string");
  assert.notEqual(bundledPath, "");
  assert.equal(getYtDlpExecutablePath().includes("yt-dlp"), true);
  assert.equal(hasYtDlp(), true);
});

test("download failures include a diagnostic log when the extractor cannot start", async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-downloads-"));
  const originalYtDlpPath = process.env.YT_DLP_PATH;

  process.env.YT_DLP_PATH = path.join(downloadsDir, "missing-yt-dlp.exe");

  try {
    await assert.rejects(
      downloadVideo(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        {
          downloadType: "video",
          format: "best",
          label: "Best available",
          value: "best"
        },
        downloadsDir
      ),
      (error) => {
        assert.equal(
          error.userMessage,
          "The bundled extractor could not start. Reinstall the app package and try again."
        );
        assert.match(error.diagnosticLog, /Classroom Video Downloader diagnostic log/);
        assert.match(error.diagnosticLog, /Operation: download/);
        assert.match(error.diagnosticLog, /Spawn error code: ENOENT/);
        assert.match(error.diagnosticLog, /Command path exists: false/);
        return true;
      }
    );
  } finally {
    if (typeof originalYtDlpPath === "undefined") {
      delete process.env.YT_DLP_PATH;
    } else {
      process.env.YT_DLP_PATH = originalYtDlpPath;
    }

    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("tries a backup extractor when the primary executable cannot start", async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-downloads-"));
  const fakeExtractor = path.join(downloadsDir, "fake-extractor.js");
  const missingExtractor = path.join(downloadsDir, "missing-primary.exe");
  const resolution = {
    downloadType: "video",
    format: "best",
    label: "Best available",
    value: "best"
  };
  const progressMessages = [];

  fs.writeFileSync(
    fakeExtractor,
    `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const pathsIndex = args.indexOf("--paths");
const downloadsDir = pathsIndex >= 0 ? args[pathsIndex + 1] : process.cwd();
const outputPath = path.join(downloadsDir, "fallback video.mp4");
fs.mkdirSync(downloadsDir, { recursive: true });
fs.writeFileSync(outputPath, "video");
console.log("__CVD_FILE__" + outputPath);
console.log("__CVD_WIDTH__1280");
console.log("__CVD_HEIGHT__720");
`
  );

  try {
    const result = await downloadVideo("https://example.com/watch", resolution, downloadsDir, {
      commandCandidates: [
        {
          command: missingExtractor,
          args: [],
          label: "missing test extractor"
        },
        {
          command: process.execPath,
          args: [fakeExtractor, ...buildDownloadArgs("https://example.com/watch", resolution, downloadsDir)],
          label: "fake backup extractor"
        }
      ],
      onProgress(progress) {
        progressMessages.push(progress.message);
      }
    });

    assert.equal(result.fileName, "fallback video.mp4");
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(
      progressMessages.includes("Primary extractor could not start. Trying backup extractor."),
      true
    );
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("tries a backup extractor when the primary requires unsupported Python", async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-downloads-"));
  const failedExtractor = path.join(downloadsDir, "python-dependent-extractor.js");
  const backupExtractor = path.join(downloadsDir, "native-backup-extractor.js");
  const outputPath = path.join(downloadsDir, "native fallback video.mp4");
  const progressMessages = [];

  fs.writeFileSync(
    failedExtractor,
    `console.error("ImportError: You are using an unsupported version of Python."); process.exit(1);`
  );
  fs.writeFileSync(
    backupExtractor,
    `
const fs = require("fs");
const outputPath = ${JSON.stringify(outputPath)};
fs.writeFileSync(outputPath, "video");
console.log("__CVD_FILE__" + outputPath);
console.log("__CVD_WIDTH__1280");
console.log("__CVD_HEIGHT__720");
`
  );

  try {
    const result = await downloadVideo(
      "https://example.com/watch",
      {
        downloadType: "video",
        format: "best",
        label: "Best available",
        value: "best"
      },
      downloadsDir,
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
        ],
        onProgress(progress) {
          progressMessages.push(progress.message);
        }
      }
    );

    assert.equal(result.filePath, outputPath);
    assert.equal(
      progressMessages.includes("Extractor runtime unavailable. Trying backup extractor."),
      true
    );
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("hands a downloaded video to Whisper and returns its captioned artifacts", async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-whisper-"));
  const fakeExtractor = path.join(downloadsDir, "fake-whisper-extractor.js");
  const originalPath = path.join(downloadsDir, "lecture original.mp4");
  const resolution = {
    downloadType: "video",
    format: "best",
    label: "Best available",
    value: "best"
  };
  let receivedWhisperOptions;

  fs.writeFileSync(
    fakeExtractor,
    `
const fs = require("fs");
const outputPath = ${JSON.stringify(originalPath)};
fs.writeFileSync(outputPath, "original-video");
console.log("__CVD_FILE__" + outputPath);
console.log("__CVD_WIDTH__1280");
console.log("__CVD_HEIGHT__720");
console.log("__CVD_DURATION__120");
`
  );

  try {
    const result = await downloadVideo("https://example.com/watch", resolution, downloadsDir, {
      transcription: { mode: "whisper", language: "auto", saveOriginal: false },
      whisperAvailable: true,
      commandCandidates: [
        {
          command: process.execPath,
          args: [
            fakeExtractor,
            ...buildDownloadArgs("https://example.com/watch", resolution, downloadsDir)
          ],
          label: "fake Whisper extractor"
        }
      ],
      createWhisperArtifacts: async (options) => {
        receivedWhisperOptions = options;
        const captionedPath = path.join(downloadsDir, "lecture captioned.mp4");
        const subtitlePath = path.join(downloadsDir, "lecture.en.srt");
        const transcriptPath = path.join(downloadsDir, "lecture.en.txt");

        fs.writeFileSync(captionedPath, "captioned-video");
        fs.writeFileSync(subtitlePath, "subtitles");
        fs.writeFileSync(transcriptPath, "transcript");

        return {
          fileName: path.basename(captionedPath),
          filePath: captionedPath,
          detectedLanguage: "en",
          detectedLanguageName: "English",
          artifacts: [
            { id: "subtitles", kind: "subtitles", filePath: subtitlePath },
            { id: "transcript", kind: "transcript", filePath: transcriptPath }
          ]
        };
      }
    });

    assert.equal(receivedWhisperOptions.mediaPath, originalPath);
    assert.equal(receivedWhisperOptions.duration, 120);
    assert.equal(receivedWhisperOptions.saveOriginal, false);
    assert.equal(result.fileName, "lecture captioned.mp4");
    assert.equal(result.detectedLanguageName, "English");
    assert.deepEqual(result.artifacts.map((artifact) => artifact.id), [
      "subtitles",
      "transcript"
    ]);
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("preserves the downloaded original when Whisper is cancelled", async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-whisper-cancel-"));
  const fakeExtractor = path.join(downloadsDir, "fake-cancel-extractor.js");
  const originalPath = path.join(downloadsDir, "cancelled original.mp4");
  const resolution = {
    downloadType: "video",
    format: "best",
    label: "Best available",
    value: "best"
  };

  fs.writeFileSync(
    fakeExtractor,
    `
const fs = require("fs");
const outputPath = ${JSON.stringify(originalPath)};
fs.writeFileSync(outputPath, "original-video");
console.log("__CVD_FILE__" + outputPath);
console.log("__CVD_WIDTH__1280");
console.log("__CVD_HEIGHT__720");
console.log("__CVD_DURATION__120");
`
  );

  try {
    const result = await downloadVideo("https://example.com/watch", resolution, downloadsDir, {
      transcription: { mode: "whisper", language: "auto", saveOriginal: true },
      whisperAvailable: true,
      commandCandidates: [
        {
          command: process.execPath,
          args: [
            fakeExtractor,
            ...buildDownloadArgs("https://example.com/watch", resolution, downloadsDir)
          ],
          label: "fake cancellation extractor"
        }
      ],
      createWhisperArtifacts: async () => {
        throw { cancelled: true };
      }
    });

    assert.equal(result.cancelled, true);
    assert.equal(result.fileName, path.basename(originalPath));
    assert.equal(result.filePath, originalPath);
    assert.deepEqual(result.artifacts, []);
    assert.equal(fs.readFileSync(originalPath, "utf8"), "original-video");
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("resolves the final MP3 when yt-dlp reports a pre-conversion path", () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-downloads-"));

  try {
    const reportedPath = path.join(downloadsDir, "lecture.webm");
    const finalPath = path.join(downloadsDir, "lecture.mp3");

    fs.writeFileSync(finalPath, "audio");

    const resolvedPath = resolveDownloadedFilePath({
      reportedPath,
      downloadsDir,
      resolution: {
        downloadType: "audio",
        audioFormat: "mp3"
      },
      startedAtMs: Date.now() - 1000
    });

    assert.equal(resolvedPath, finalPath);
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("falls back to the newest matching audio file when the reported path is stale", () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-downloads-"));

  try {
    const startedAtMs = Date.now() - 1000;
    const finalPath = path.join(downloadsDir, "different-title.mp3");

    fs.writeFileSync(path.join(downloadsDir, "older.mp3"), "old");
    fs.utimesSync(path.join(downloadsDir, "older.mp3"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.writeFileSync(finalPath, "audio");

    const resolvedPath = resolveDownloadedFilePath({
      reportedPath: path.join(downloadsDir, "lecture.webm"),
      downloadsDir,
      resolution: {
        downloadType: "audio",
        audioFormat: "mp3"
      },
      startedAtMs
    });

    assert.equal(resolvedPath, finalPath);
  } finally {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});
