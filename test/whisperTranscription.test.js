const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  alignSrtToSpeechSegments,
  buildWhisperArgs,
  createCancelledWhisperError,
  createWhisperArtifacts,
  createWhisperWorkspace,
  estimateWhisperTime,
  parseWhisperOutput,
  parseWhisperVadSegments,
  prepareWhisperCommandParts
} = require("../src/whisperTranscription");

test("builds multilingual automatic Whisper Large v3 Turbo Q5_0 CLI arguments", () => {
  const args = buildWhisperArgs({
    modelPath: "model.bin",
    vadModelPath: "vad-model.bin",
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
  assert.deepEqual(
    args.slice(args.indexOf("--vad"), args.indexOf("--vad") + 3),
    ["--vad", "--vad-model", "vad-model.bin"]
  );
  assert.equal(args.at(-1), "6");
});

test("parses VAD segments and aligns cues away from silent gaps", () => {
  const speechSegments = parseWhisperVadSegments([
    "whisper_vad_segments_from_probs: VAD segment 0: start = 8.00, end = 8.96",
    "whisper_vad_segments_from_probs: VAD segment 1: start = 9.51, end = 25.98",
    "whisper_vad_segments_from_probs: VAD segment 2: start = 26.15, end = 26.91",
    "whisper_vad_segments_from_probs: VAD segment 3: start = 32.26, end = 40.29"
  ].join("\n"));
  const srt = [
    "1",
    "00:00:08,000 --> 00:00:13,150",
    "Opening explanation",
    "",
    "2",
    "00:00:25,270 --> 00:00:26,090",
    "End of the first section",
    "",
    "3",
    "00:00:26,090 --> 00:00:35,190",
    "The next section begins after the pause",
    ""
  ].join("\n");

  assert.deepEqual(speechSegments, [
    { start: 8, end: 8.96 },
    { start: 9.51, end: 25.98 },
    { start: 26.15, end: 26.91 },
    { start: 32.26, end: 40.29 }
  ]);
  assert.equal(
    alignSrtToSpeechSegments(srt, speechSegments),
    [
      "1",
      "00:00:09,510 --> 00:00:13,150",
      "Opening explanation",
      "",
      "2",
      "00:00:25,270 --> 00:00:26,090",
      "End of the first section",
      "",
      "3",
      "00:00:32,260 --> 00:00:35,190",
      "The next section begins after the pause",
      ""
    ].join("\n")
  );
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
  const unicodeVadModel = path.join(
    tempRoot,
    "vad-model-\u05e2\u05d1\u05e8\u05d9\u05ea.bin"
  );
  const workspace = path.join(tempRoot, "workspace");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  fs.mkdirSync(unicodeRuntime, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(unicodeRuntime, "whisper-cli.exe"), "runtime");
  fs.writeFileSync(path.join(unicodeRuntime, "backend.dll"), "backend");
  fs.writeFileSync(unicodeModel, "model");
  fs.writeFileSync(unicodeVadModel, "vad-model");

  const prepared = await prepareWhisperCommandParts(
    {
      command: path.join(unicodeRuntime, "whisper-cli.exe"),
      args: [],
      modelPath: unicodeModel,
      vadModelPath: unicodeVadModel
    },
    workspace,
    { platform: "win32" }
  );

  assert.match(prepared.command, /^[\x20-\x7e]+$/);
  assert.match(prepared.modelPath, /^[\x20-\x7e]+$/);
  assert.match(prepared.vadModelPath, /^[\x20-\x7e]+$/);
  assert.equal(fs.readFileSync(prepared.command, "utf8"), "runtime");
  assert.equal(
    fs.readFileSync(path.join(path.dirname(prepared.command), "backend.dll"), "utf8"),
    "backend"
  );
  assert.equal(fs.readFileSync(prepared.modelPath, "utf8"), "model");
  assert.equal(fs.readFileSync(prepared.vadModelPath, "utf8"), "vad-model");
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

test("defers Whisper rendering and preserves review artifacts after transcription", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-whisper-review-"));
  const mediaPath = path.join(directory, "review.mp4");
  let rendererStarted = false;

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(mediaPath, "original-video");

  const result = await createWhisperArtifacts({
    mediaPath,
    duration: 45,
    width: 1280,
    height: 720,
    saveOriginal: true,
    deferRender: true,
    ffmpegCommandParts: { command: "ffmpeg", args: [] },
    whisperCommandParts: { command: "whisper", args: [], modelPath: "model" },
    extractAudioImpl: async ({ audioPath }) => fs.promises.writeFile(audioPath, "wav"),
    runWhisperImpl: async ({ outputPrefix }) => {
      const srtPath = `${outputPrefix}.srt`;
      await fs.promises.writeFile(
        srtPath,
        "1\n00:00:01,000 --> 00:00:03,000\nEditable Whisper cue\n",
        "utf8"
      );
      return { language: "en", srtPath };
    },
    renderImpl: async () => {
      rendererStarted = true;
    }
  });

  assert.equal(rendererStarted, false);
  assert.equal(result.filePath, mediaPath);
  assert.equal(result.review.mode, "whisper");
  assert.equal(result.review.language, "en");
  assert.equal(result.review.width, 1280);
  assert.equal(result.review.height, 720);
  assert.deepEqual(
    result.review.artifacts.map((artifact) => artifact.kind),
    ["subtitles", "transcript", "original-video"]
  );
  assert.equal(
    fs.readFileSync(result.review.transcriptPath, "utf8"),
    "Editable Whisper cue\n"
  );
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
