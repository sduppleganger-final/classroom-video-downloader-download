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
    renderImpl = renderCaptionedVideo
  } = options;
  const stem = path.basename(mediaPath, path.extname(mediaPath));
  const directory = path.dirname(mediaPath);
  const audioPath = path.join(directory, `${stem} - whisper-audio.wav`);
  const outputPrefix = path.join(directory, `${stem} - whisper-working`);
  const workingSrtPath = `${outputPrefix}.srt`;
  const workingJsonPath = `${outputPrefix}.json`;
  let subtitlePath = "";
  let transcriptPath = "";
  let captionedPath = "";

  try {
    throwIfAborted(signal, mediaPath);
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
      commandParts: whisperCommandParts,
      spawnImpl
    });
    const language = normalizeLanguageCode(whisperResult.language) || "und";
    const languageName = getLanguageDisplayName(language);

    subtitlePath = path.join(directory, `${stem}.${language}.srt`);
    await fs.promises.rename(whisperResult.srtPath || workingSrtPath, subtitlePath);

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

    await removeGeneratedFiles([audioPath, workingJsonPath]);

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
      audioPath,
      workingSrtPath,
      workingJsonPath,
      subtitlePath,
      transcriptPath,
      captionedPath
    ]);

    if (error?.cancelled || signal?.aborted) {
      throw createCancelledWhisperError(mediaPath, error);
    }

    throw error;
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
    audioPath,
    outputPrefix,
    threads
  });
  const startedAtMs = Date.now();
  let detectedLanguage = "";
  let lastProgress = -1;
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
    onStderr: readProgress
  });

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

  return { language, srtPath, jsonPath };
}

function buildWhisperArgs({ modelPath, audioPath, outputPrefix, threads }) {
  return [
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
    "--split-on-word",
    "--max-len",
    "42",
    "--threads",
    String(threads)
  ];
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
  buildWhisperArgs,
  createCancelledWhisperError,
  createWhisperArtifacts,
  estimateWhisperTime,
  extractWhisperAudio,
  formatTimeRange,
  getLanguageDisplayName,
  parseWhisperOutput,
  runWhisperTranscription
};
