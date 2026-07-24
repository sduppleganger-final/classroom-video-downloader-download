const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  renderCaptionedVideo,
  srtToReadableText
} = require("./sourceSubtitles");
const { getWhisperCommandParts } = require("./whisperPaths");

async function createWhisperArtifacts(options) {
  const {
    mediaPath,
    duration,
    saveOriginal = true,
    signal,
    onProgress,
    ffmpegCommandParts = { command: "ffmpeg", args: [] },
    whisperCommandParts = getWhisperCommandParts(),
    spawnImpl = spawn,
    extractAudioImpl = extractWhisperAudio,
    runWhisperImpl = runWhisperTranscription,
    renderImpl = renderCaptionedVideo,
    createWorkspaceImpl = createWhisperWorkspace
  } = options;
  const stem = path.basename(mediaPath, path.extname(mediaPath));
  const directory = path.dirname(mediaPath);
  let workspaceDirectory = "";
  let audioPath = "";
  let outputPrefix = "";
  let workingSrtPath = "";
  let workingJsonPath = "";
  let activeWhisperCommandParts = whisperCommandParts;
  let subtitlePath = "";
  let transcriptPath = "";
  let captionedPath = "";

  try {
    throwIfAborted(signal, mediaPath);
    workspaceDirectory = await createWorkspaceImpl();
    audioPath = path.join(workspaceDirectory, "audio.wav");
    outputPrefix = path.join(workspaceDirectory, "transcript");
    workingSrtPath = `${outputPrefix}.srt`;
    workingJsonPath = `${outputPrefix}.json`;
    activeWhisperCommandParts = await prepareWhisperCommandParts(
      whisperCommandParts,
      workspaceDirectory
    );
    reportProgress(onProgress, {
      percent: 55,
      stage: "preparing-transcription",
      canCancel: true,
      message: "The video is downloaded. Preparing its audio for Whisper."
    });

    await extractAudioImpl({
      mediaPath,
      audioPath,
      ffmpegCommandParts,
      duration,
      signal,
      onProgress,
      spawnImpl
    });

    const initialEstimate = estimateWhisperTime(duration);

    reportProgress(onProgress, {
      percent: 60,
      stage: "transcribing",
      canCancel: true,
      estimatedSecondsRemaining: initialEstimate?.likelySeconds || null,
      message: initialEstimate
        ? `Whisper is transcribing locally. Initial estimate: ${formatTimeRange(initialEstimate)}.`
        : "Whisper is transcribing locally. Timing depends on this computer."
    });

    const whisperResult = await runWhisperImpl({
      audioPath,
      outputPrefix,
      duration,
      signal,
      onProgress,
      commandParts: activeWhisperCommandParts,
      spawnImpl
    });
    const language = normalizeLanguageCode(whisperResult.language) || "und";
    const languageName = getLanguageDisplayName(language);

    subtitlePath = path.join(directory, `${stem}.${language}.srt`);
    await moveGeneratedFile(whisperResult.srtPath || workingSrtPath, subtitlePath);

    const srt = await fs.promises.readFile(subtitlePath, "utf8");

    if (!srt.trim()) {
      throw createWhisperError("Whisper completed without producing a transcript.");
    }

    transcriptPath = path.join(directory, `${stem}.${language}.txt`);
    await fs.promises.writeFile(transcriptPath, srtToReadableText(srt), "utf8");

    reportProgress(onProgress, {
      percent: 90,
      stage: "rendering-transcription",
      canCancel: true,
      detectedLanguage: language,
      detectedLanguageName: languageName,
      message: `Detected ${languageName}. Rendering bottom-centered captions into the video.`
    });

    captionedPath = path.join(directory, `${stem} - Whisper captioned ${language}.mp4`);
    await renderImpl({
      inputPath: mediaPath,
      subtitlePath,
      outputPath: captionedPath,
      duration,
      ffmpegCommandParts,
      signal,
      captionPosition: "bottom-center",
      progressStart: 90,
      progressEnd: 99,
      progressStage: "rendering-transcription",
      progressMessage: "Rendering Whisper captions into the video",
      completionMessage: "Finalizing the Whisper video, SRT, and TXT files.",
      timeoutMs: 0,
      onProgress,
      spawnImpl
    });

    const artifacts = [
      {
        id: "subtitles",
        kind: "subtitles",
        fileName: path.basename(subtitlePath),
        filePath: subtitlePath
      },
      {
        id: "transcript",
        kind: "transcript",
        fileName: path.basename(transcriptPath),
        filePath: transcriptPath
      }
    ];

    if (saveOriginal) {
      artifacts.push({
        id: "original-video",
        kind: "original-video",
        fileName: path.basename(mediaPath),
        filePath: mediaPath
      });
    }

    await removeWhisperWorkspace(workspaceDirectory);

    return {
      fileName: path.basename(captionedPath),
      filePath: captionedPath,
      artifacts,
      cleanupFilePaths: saveOriginal ? [] : [mediaPath],
      detectedLanguage: language,
      detectedLanguageName: languageName
    };
  } catch (error) {
    await removeGeneratedFiles([
      subtitlePath,
      transcriptPath,
      captionedPath
    ]);
    await removeWhisperWorkspace(workspaceDirectory);

    if (error?.cancelled || signal?.aborted) {
      throw createCancelledWhisperError(mediaPath, error);
    }

    throw error;
  }
}

async function createWhisperWorkspace(options = {}) {
  const platform = options.platform || process.platform;
  const requestedRoot = options.tempRoot || process.env.CVD_WHISPER_TEMP_DIR;
  const systemDrive = process.env.SystemDrive || "C:";
  const candidates = requestedRoot
    ? [requestedRoot]
    : platform === "win32"
      ? [
          process.env.TEMP,
          os.tmpdir(),
          process.env.PUBLIC,
          path.join(systemDrive, "Users", "Public")
        ]
      : [os.tmpdir()];
  const failures = [];

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const resolvedRoot = path.resolve(candidate);

    if (platform === "win32" && !isAsciiPath(resolvedRoot)) {
      failures.push(`${resolvedRoot}: path contains non-ASCII characters`);
      continue;
    }

    try {
      const appTempRoot = path.join(resolvedRoot, "ClassroomVideoDownloader");
      await fs.promises.mkdir(appTempRoot, { recursive: true });
      const workspaceDirectory = await fs.promises.mkdtemp(
        path.join(appTempRoot, "whisper-")
      );

      if (platform === "win32" && !isAsciiPath(workspaceDirectory)) {
        await removeWhisperWorkspace(workspaceDirectory);
        failures.push(
          `${workspaceDirectory}: generated path contains non-ASCII characters`
        );
        continue;
      }

      return workspaceDirectory;
    } catch (error) {
      failures.push(`${resolvedRoot}: ${error.code || error.message}`);
    }
  }

  throw createWhisperError(
    "Whisper could not create a compatible temporary working folder.",
    { stderr: failures.join("\n") }
  );
}

function isAsciiPath(filePath) {
  return /^[\x20-\x7e]+$/.test(String(filePath || ""));
}

async function prepareWhisperCommandParts(
  commandParts,
  workspaceDirectory,
  options = {}
) {
  const platform = options.platform || process.platform;

  if (platform !== "win32") {
    return commandParts;
  }

  if (!isAsciiPath(workspaceDirectory)) {
    throw createWhisperError(
      "Whisper could not create a Windows-compatible working path."
    );
  }

  let command = commandParts.command;
  let modelPath = commandParts.modelPath;
  let vadModelPath = commandParts.vadModelPath;

  try {
    if (!isAsciiPath(command)) {
      const sourceRuntimeDirectory = path.dirname(command);
      const targetRuntimeDirectory = path.join(workspaceDirectory, "runtime");
      await fs.promises.mkdir(targetRuntimeDirectory, { recursive: true });

      const runtimeEntries = await fs.promises.readdir(sourceRuntimeDirectory, {
        withFileTypes: true
      });

      for (const entry of runtimeEntries) {
        if (!entry.isFile()) {
          continue;
        }

        await createTemporaryFileAlias(
          path.join(sourceRuntimeDirectory, entry.name),
          path.join(targetRuntimeDirectory, entry.name)
        );
      }

      command = path.join(targetRuntimeDirectory, path.basename(command));
    }

    if (!isAsciiPath(modelPath)) {
      const targetModelPath = path.join(workspaceDirectory, "model.bin");
      await createTemporaryFileAlias(modelPath, targetModelPath);
      modelPath = targetModelPath;
    }

    if (vadModelPath && !isAsciiPath(vadModelPath)) {
      const targetVadModelPath = path.join(workspaceDirectory, "vad-model.bin");
      await createTemporaryFileAlias(vadModelPath, targetVadModelPath);
      vadModelPath = targetVadModelPath;
    }
  } catch (error) {
    throw createWhisperError(
      "Whisper could not prepare its bundled Windows runtime.",
      { cause: error, stderr: error.message }
    );
  }

  return { ...commandParts, command, modelPath, vadModelPath };
}

async function createTemporaryFileAlias(sourcePath, targetPath) {
  try {
    // A hard link avoids copying the 466 MiB model for every transcription.
    await fs.promises.link(sourcePath, targetPath);
  } catch {
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

async function moveGeneratedFile(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }

    await fs.promises.copyFile(sourcePath, targetPath);
    await fs.promises.rm(sourcePath, { force: true });
  }
}

async function extractWhisperAudio(options) {
  const {
    mediaPath,
    audioPath,
    ffmpegCommandParts,
    signal,
    onProgress,
    spawnImpl = spawn
  } = options;
  const args = [
    ...(ffmpegCommandParts.args || []),
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    mediaPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath
  ];

  reportProgress(onProgress, {
    percent: 57,
    stage: "preparing-transcription",
    canCancel: true,
    message: "Converting the audio into Whisper's local analysis format."
  });

  const result = await runChildProcess({
    command: ffmpegCommandParts.command,
    args,
    signal,
    spawnImpl,
    cancellationFilePath: mediaPath
  });

  if (result.code !== 0 || !isNonEmptyFile(audioPath)) {
    throw createWhisperError("The video's audio could not be prepared for Whisper.", {
      exitCode: result.code,
      stderr: result.stderr,
      commandParts: { command: ffmpegCommandParts.command, args }
    });
  }
}

async function runWhisperTranscription(options) {
  const {
    audioPath,
    outputPrefix,
    duration,
    signal,
    onProgress,
    commandParts,
    spawnImpl = spawn
  } = options;
  const threads = Math.max(2, Math.min(8, Math.max(2, os.cpus().length - 1)));
  const args = buildWhisperArgs({
    modelPath: commandParts.modelPath,
    vadModelPath: commandParts.vadModelPath,
    audioPath,
    outputPrefix,
    threads
  });
  const startedAtMs = Date.now();
  let detectedLanguage = "";
  let lastProgress = -1;
  const vadSegmentCollector = createVadSegmentCollector();
  const readProgress = (text) => {
    const parsed = parseWhisperOutput(text);

    if (parsed.language) {
      detectedLanguage = parsed.language;
    }

    if (parsed.progress === null || parsed.progress <= lastProgress) {
      return;
    }

    lastProgress = parsed.progress;
    const elapsedSeconds = Math.max(1, (Date.now() - startedAtMs) / 1000);
    const remainingSeconds = parsed.progress > 0
      ? Math.max(0, Math.round((elapsedSeconds / parsed.progress) * (100 - parsed.progress)))
      : null;
    const languageName = detectedLanguage
      ? getLanguageDisplayName(detectedLanguage)
      : "the spoken language";
    const remainingMessage = remainingSeconds
      ? ` About ${formatDuration(remainingSeconds)} remaining.`
      : "";

    reportProgress(onProgress, {
      percent: 60 + (parsed.progress / 100) * 29,
      stage: "transcribing",
      canCancel: true,
      detectedLanguage: detectedLanguage || null,
      detectedLanguageName: detectedLanguage
        ? getLanguageDisplayName(detectedLanguage)
        : null,
      estimatedSecondsRemaining: remainingSeconds,
      message: `Whisper is transcribing ${languageName} (${parsed.progress}%).${remainingMessage}`
    });
  };
  const result = await runChildProcess({
    command: commandParts.command,
    args: [...(commandParts.args || []), ...args],
    signal,
    spawnImpl,
    cancellationFilePath: audioPath,
    onStdout: readProgress,
    onStderr: (text) => {
      readProgress(text);
      vadSegmentCollector.push(text);
    }
  });
  const speechSegments = vadSegmentCollector.finish();

  if (result.code !== 0) {
    throw createWhisperError("Whisper could not transcribe this video's audio.", {
      exitCode: result.code,
      stderr: result.stderr,
      commandParts: {
        command: commandParts.command,
        args: [...(commandParts.args || []), ...args]
      }
    });
  }

  const jsonPath = `${outputPrefix}.json`;
  const json = await readJson(jsonPath);
  const language = normalizeLanguageCode(
    json?.result?.language || json?.language || detectedLanguage
  );
  const srtPath = `${outputPrefix}.srt`;

  if (!isNonEmptyFile(srtPath)) {
    throw createWhisperError("Whisper completed without producing timestamped subtitles.", {
      stderr: result.stderr,
      commandParts: {
        command: commandParts.command,
        args: [...(commandParts.args || []), ...args]
      }
    });
  }

  if (speechSegments.length) {
    const originalSrt = await fs.promises.readFile(srtPath, "utf8");
    const alignedSrt = alignSrtToSpeechSegments(originalSrt, speechSegments);

    if (alignedSrt !== originalSrt) {
      await fs.promises.writeFile(srtPath, alignedSrt, "utf8");
    }
  }

  return { language, srtPath, jsonPath, speechSegments };
}

function buildWhisperArgs({ modelPath, vadModelPath, audioPath, outputPrefix, threads }) {
  const args = [
    "--model",
    modelPath,
    "--file",
    audioPath,
    "--language",
    "auto",
    "--output-srt",
    "--output-json",
    "--output-file",
    outputPrefix,
    "--print-progress",
  ];

  if (vadModelPath) {
    args.push("--vad", "--vad-model", vadModelPath);
  }

  args.push(
    "--split-on-word",
    "--max-len",
    "42",
    "--threads",
    String(threads)
  );

  return args;
}

function createVadSegmentCollector() {
  let pending = "";
  const segments = [];

  const readLine = (line) => {
    const match = String(line).match(
      /VAD segment\s+\d+:\s+start\s*=\s*(\d+(?:\.\d+)?),\s+end\s*=\s*(\d+(?:\.\d+)?)/i
    );

    if (!match) {
      return;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);

    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      segments.push({ start, end });
    }
  };

  return {
    push(value) {
      const lines = `${pending}${String(value || "")}`.split(/\r?\n/);
      pending = lines.pop() || "";
      lines.forEach(readLine);
    },
    finish() {
      readLine(pending);
      return normalizeSpeechSegments(segments);
    }
  };
}

function parseWhisperVadSegments(value) {
  const collector = createVadSegmentCollector();
  collector.push(value);
  return collector.finish();
}

function alignSrtToSpeechSegments(srt, speechSegments, options = {}) {
  const cues = parseSrtCues(srt);

  if (!cues.length) {
    return srt;
  }

  const mergedSpeech = mergeSpeechSegments(
    normalizeSpeechSegments(speechSegments),
    options.mergeGapSeconds ?? 0.4
  );

  if (!mergedSpeech.length) {
    return srt;
  }

  const dominanceRatio = options.dominanceRatio ?? 1.5;
  const minimumCueSeconds = options.minimumCueSeconds ?? 0.2;
  let previousEnd = 0;

  const aligned = cues.map((cue) => {
    const overlaps = mergedSpeech
      .map((segment) => ({
        segment,
        duration: Math.max(
          0,
          Math.min(cue.end, segment.end) - Math.max(cue.start, segment.start)
        )
      }))
      .filter((overlap) => overlap.duration > 0);

    if (!overlaps.length) {
      previousEnd = Math.max(previousEnd, cue.end);
      return cue;
    }

    const first = overlaps[0];
    const dominant = overlaps.reduce((best, overlap) =>
      overlap.duration > best.duration ? overlap : best
    );
    let start = cue.start;
    let end = cue.end;

    if (start < first.segment.start) {
      start = first.segment.start;
    }

    if (
      dominant !== first &&
      dominant.segment.start - first.segment.end >= (options.mergeGapSeconds ?? 0.4) &&
      dominant.duration >= first.duration * dominanceRatio
    ) {
      start = dominant.segment.start;
    }

    const last = overlaps.at(-1);

    if (end > last.segment.end && end - last.segment.end >= 0.05) {
      end = last.segment.end;
    }

    start = Math.max(start, previousEnd);

    if (end <= start) {
      end = Math.min(cue.end, start + minimumCueSeconds);
    }

    previousEnd = Math.max(previousEnd, end);
    return { ...cue, start, end };
  });

  return formatSrtCues(aligned, String(srt).includes("\r\n") ? "\r\n" : "\n");
}

function normalizeSpeechSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end)
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.start >= 0 &&
        segment.end > segment.start
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function mergeSpeechSegments(segments, maximumGapSeconds) {
  const merged = [];

  for (const segment of segments) {
    const previous = merged.at(-1);

    if (previous && segment.start - previous.end < maximumGapSeconds) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

function parseSrtCues(srt) {
  return String(srt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block, blockIndex) => {
      const lines = block.split("\n");
      const index = /^\d+$/.test(lines[0]?.trim() || "")
        ? Number(lines.shift().trim())
        : blockIndex + 1;
      const timing = lines.shift()?.match(
        /^(\d{1,2}:\d{2}:\d{2}[,.]\d+)\s+-->\s+(\d{1,2}:\d{2}:\d{2}[,.]\d+)$/
      );

      if (!timing || !lines.length) {
        return null;
      }

      return {
        index,
        start: parseSrtTimestamp(timing[1]),
        end: parseSrtTimestamp(timing[2]),
        text: lines.join("\n")
      };
    })
    .filter(
      (cue) =>
        cue &&
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.end > cue.start
    );
}

function parseSrtTimestamp(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d+)$/);

  if (!match) {
    return Number.NaN;
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(`0.${match[4]}`)
  );
}

function formatSrtCues(cues, newline) {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}${newline}${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}${newline}${cue.text}`
    )
    .join(`${newline}${newline}`)}${newline}`;
}

function formatSrtTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const remainder = milliseconds % 1000;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":") + `,${String(remainder).padStart(3, "0")}`;
}

function parseWhisperOutput(value) {
  const text = String(value || "");
  const progressMatches = [...text.matchAll(/progress\s*=\s*(\d{1,3})%/gi)];
  const languageMatches = [
    ...text.matchAll(/auto-detected language:\s*([a-z]{2,8}(?:-[a-z0-9]+)?)/gi)
  ];
  const progressValue = progressMatches.at(-1)?.[1];

  return {
    progress: progressValue === undefined
      ? null
      : Math.max(0, Math.min(100, Number(progressValue))),
    language: normalizeLanguageCode(languageMatches.at(-1)?.[1])
  };
}

function estimateWhisperTime(durationSeconds) {
  const duration = Number(durationSeconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  return {
    minimumSeconds: Math.max(30, Math.round(duration * 0.5)),
    likelySeconds: Math.max(45, Math.round(duration)),
    maximumSeconds: Math.max(60, Math.round(duration * 2))
  };
}

function formatTimeRange(estimate) {
  return `${formatDuration(estimate.minimumSeconds)}-${formatDuration(estimate.maximumSeconds)}`;
}

function formatDuration(seconds) {
  const roundedMinutes = Math.max(1, Math.round(Number(seconds) / 60));

  if (roundedMinutes < 60) {
    return `${roundedMinutes} minute${roundedMinutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;

  return minutes
    ? `${hours}h ${minutes}m`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

function getLanguageDisplayName(code) {
  const normalized = normalizeLanguageCode(code);

  if (!normalized || normalized === "und") {
    return "an undetermined language";
  }

  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(normalized) || normalized;
  } catch {
    return normalized;
  }
}

function normalizeLanguageCode(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";

  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(code) ? code : "";
}

function runChildProcess(options) {
  const {
    command,
    args,
    signal,
    spawnImpl = spawn,
    onStdout,
    onStderr,
    cancellationFilePath
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancelledWhisperError(cancellationFilePath));
      return;
    }

    const child = spawnImpl(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let startupFailed = false;
    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill();
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = `${stdout}${text}`.slice(-24000);
      onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-24000);
      onStderr?.(text);
    });
    child.on("error", (error) => {
      startupFailed = true;
      signal?.removeEventListener("abort", abort);
      reject(
        createWhisperError("A bundled transcription helper could not start.", {
          cause: error,
          commandParts: { command, args },
          stderr
        })
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);

      if (startupFailed) {
        return;
      }

      if (aborted) {
        reject(createCancelledWhisperError(cancellationFilePath));
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

function throwIfAborted(signal, preservedFilePath) {
  if (signal?.aborted) {
    throw createCancelledWhisperError(preservedFilePath);
  }
}

function createCancelledWhisperError(preservedFilePath, cause) {
  return createWhisperError(
    "Transcription was cancelled. The non-captioned video has been kept.",
    {
      cancelled: true,
      preservedFilePath,
      cause
    }
  );
}

function createWhisperError(userMessage, details = {}) {
  return Object.assign(new Error(userMessage), details, { userMessage });
}

async function removeGeneratedFiles(filePaths) {
  await Promise.all(
    [...new Set(filePaths.filter(Boolean))].map((filePath) =>
      fs.promises.rm(filePath, { force: true }).catch(() => {})
    )
  );
}

async function removeWhisperWorkspace(workspaceDirectory) {
  if (!workspaceDirectory) {
    return;
  }

  await fs.promises
    .rm(workspaceDirectory, { recursive: true, force: true })
    .catch(() => {});
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isNonEmptyFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress === "function") {
    onProgress(progress);
  }
}

module.exports = {
  alignSrtToSpeechSegments,
  buildWhisperArgs,
  createCancelledWhisperError,
  createWhisperArtifacts,
  createWhisperWorkspace,
  estimateWhisperTime,
  extractWhisperAudio,
  formatTimeRange,
  getLanguageDisplayName,
  parseWhisperOutput,
  parseWhisperVadSegments,
  prepareWhisperCommandParts,
  runWhisperTranscription
};
