const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildWhisperArgs,
  createCancelledWhisperError,
  createWhisperArtifacts,
  createWhisperWorkspace,
  estimateWhisperTime,
  parseWhisperOutput,
  prepareWhisperCommandParts
} = require("../src/whisperTranscription");

test("builds multilingual automatic Whisper Small CLI arguments", () => {
  const args = buildWhisperArgs({
    modelPath: "model.bin",
    audioPath: "audio.wav",
    outputPrefix: "transcript",
    threads: 6
  });

  assert.deepEqual(args.slice(0, 6), [
    "--model",
    "model.bin",
    "--file",
    "audio.wav",
    "--language",
    "auto"
  ]);
  assert.equal(args.includes("--output-srt"), true);
  assert.equal(args.includes("--output-json"), true);
  assert.equal(args.includes("--print-progress"), true);
  assert.equal(args.at(-1), "6");
});

test("parses detected language and latest Whisper progress", () => {
  assert.deepEqual(
    parseWhisperOutput(`auto-detected language: he (p = 0.97)\nprogress = 23%\nprogress = 41%`),
    { progress: 41, language: "he" }
  );
  assert.deepEqual(parseWhisperOutput("ordinary output"), {
    progress: null,
    language: ""
  });
});

test("estimates a broad local transcription time range without a duration limit", () => {
  assert.deepEqual(estimateWhisperTime(3600), {
    minimumSeconds: 1800,
    likelySeconds: 3600,
    maximumSeconds: 7200
  });
  assert.equal(estimateWhisperTime(null), null);
});

test("creates an ASCII-only Windows workspace for the native Whisper CLI", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-ascii-root-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const workspace = await createWhisperWorkspace({
    platform: "win32",
    tempRoot
  });

  assert.match(workspace, /^[\x20-\x7e]+$/);
  assert.equal(path.dirname(workspace), path.join(tempRoot, "ClassroomVideoDownloader"));
});

test("aliases Unicode Windows runtime and model paths into the ASCII workspace", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-whisper-alias-"));
  const unicodeRuntime = path.join(tempRoot, "runtime-\u05e2\u05d1\u05e8\u05d9\u05ea");
  const unicodeModel = path.join(tempRoot, "model-\u05e2\u05d1\u05e8\u05d9\u05ea.bin");
  const workspace = path.join(tempRoot, "workspace");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  fs.mkdirSync(unicodeRuntime, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(unicodeRuntime, "whisper-cli.exe"), "runtime");
  fs.writeFileSync(path.join(unicodeRuntime, "backend.dll"), "backend");
  fs.writeFileSync(unicodeModel, "model");

  const prepared = await prepareWhisperCommandParts(
    {
      command: path.join(unicodeRuntime, "whisper-cli.exe"),
      args: [],
      modelPath: unicodeModel
    },
    workspace,
    { platform: "win32" }
  );

  assert.match(prepared.command, /^[\x20-\x7e]+$/);
  assert.match(prepared.modelPath, /^[\x20-\x7e]+$/);
  assert.equal(fs.readFileSync(prepared.command, "utf8"), "runtime");
  assert.equal(
    fs.readFileSync(path.join(path.dirname(prepared.command), "backend.dll"), "utf8"),
    "backend"
  );
  assert.equal(fs.readFileSync(prepared.modelPath, "utf8"), "model");
});

test("creates a bottom-captioned MP4, SRT, TXT, and optional original artifact", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-whisper-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaPath = path.join(
    directory,
    "Lecture \u05e9\u05dc\u05d5\u05dd\uFF1A - 2026-07-24_00-00-00.mp4"
  );
  fs.writeFileSync(mediaPath, "original-video");
  const progress = [];
  let renderOptions = null;
  let whisperInputPaths = null;

  const result = await createWhisperArtifacts({
    mediaPath,
    duration: 120,
    saveOriginal: true,
    ffmpegCommandParts: { command: "ffmpeg", args: [] },
    whisperCommandParts: { command: "whisper", args: [], modelPath: "model" },
    extractAudioImpl: async ({ audioPath }) => fs.promises.writeFile(audioPath, "wav"),
    runWhisperImpl: async ({ audioPath, outputPrefix }) => {
      whisperInputPaths = { audioPath, outputPrefix };
      const srtPath = `${outputPrefix}.srt`;
      await fs.promises.writeFile(
        srtPath,
        "1\n00:00:00,000 --> 00:00:02,000\nשלום כיתה\n",
        "utf8"
      );
      await fs.promises.writeFile(
        `${outputPrefix}.json`,
        JSON.stringify({ result: { language: "he" } })
      );
      return { language: "he", srtPath };
    },
    renderImpl: async (options) => {
      renderOptions = options;
      await fs.promises.writeFile(options.outputPath, "captioned-video");
    },
    onProgress: (update) => progress.push(update)
  });

  assert.doesNotMatch(whisperInputPaths.audioPath, /\u05e9|\uFF1A/);
  assert.doesNotMatch(whisperInputPaths.outputPrefix, /\u05e9|\uFF1A/);
  assert.equal(fs.existsSync(path.dirname(whisperInputPaths.audioPath)), false);
  assert.equal(renderOptions.captionPosition, "bottom-center");
  assert.equal(result.detectedLanguage, "he");
  assert.equal(
    result.fileName,
    "Lecture \u05e9\u05dc\u05d5\u05dd\uFF1A - 2026-07-24_00-00-00 - Whisper captioned he.mp4"
  );
  assert.deepEqual(
    result.artifacts.map((artifact) => [artifact.id, artifact.kind]),
    [
      ["subtitles", "subtitles"],
      ["transcript", "transcript"],
      ["original-video", "original-video"]
    ]
  );
  assert.equal(fs.readFileSync(result.artifacts[1].filePath, "utf8"), "שלום כיתה\n");
  assert.equal(progress.some((update) => update.detectedLanguage === "he"), true);
});

test("cancellation removes partial transcript files and preserves the original video", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-whisper-cancel-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaPath = path.join(directory, "original.mp4");
  fs.writeFileSync(mediaPath, "original-video");

  await assert.rejects(
    createWhisperArtifacts({
      mediaPath,
      duration: 30,
      ffmpegCommandParts: { command: "ffmpeg", args: [] },
      whisperCommandParts: { command: "whisper", args: [], modelPath: "model" },
      extractAudioImpl: async ({ audioPath }) => fs.promises.writeFile(audioPath, "wav"),
      runWhisperImpl: async () => {
        throw createCancelledWhisperError(mediaPath);
      }
    }),
    (error) =>
      error.cancelled === true &&
      error.preservedFilePath === mediaPath &&
      /has been kept/.test(error.userMessage)
  );

  assert.equal(fs.existsSync(mediaPath), true);
  assert.deepEqual(fs.readdirSync(directory), ["original.mp4"]);
});
