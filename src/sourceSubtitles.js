const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sourceSubtitleKinds = {
  manual: "manual",
  automatic: "automatic"
};

function extractSubtitleLanguages(payload = {}) {
  const languages = new Map();

  addSubtitleLanguages(languages, payload.subtitles, sourceSubtitleKinds.manual);
  addSubtitleLanguages(
    languages,
    payload.automatic_captions,
    sourceSubtitleKinds.automatic
  );

  return [...languages.values()].sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base"
    });

    return nameComparison || left.code.localeCompare(right.code);
  });
}

function addSubtitleLanguages(target, source, kind) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }

  for (const [code, formats] of Object.entries(source)) {
    if (
      code === "live_chat" ||
      !isSafeSubtitleLanguageCode(code) ||
      !Array.isArray(formats) ||
      !formats.length
    ) {
      continue;
    }

    const existing = target.get(code);

    if (existing?.source === sourceSubtitleKinds.manual) {
      continue;
    }

    const name = formats
      .map((format) => cleanLanguageName(format?.name))
      .find(Boolean);

    target.set(code, {
      code,
      name: name || code,
      source: kind
    });
  }
}

function cleanLanguageName(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
    : "";
}

function normalizeSourceSubtitleSelection(value, resolution) {
  const enabled = value?.enabled === true;

  if (!enabled) {
    return {
      ok: true,
      value: {
        enabled: false,
        language: ""
      }
    };
  }

  if (resolution?.downloadType !== "video") {
    return {
      ok: false,
      message: "Source subtitles can only be added to a video download."
    };
  }

  const language = typeof value?.language === "string" ? value.language.trim() : "";

  if (!isSafeSubtitleLanguageCode(language)) {
    return {
      ok: false,
      message: "Choose one of the available source subtitle languages."
    };
  }

  return {
    ok: true,
    value: {
      enabled: true,
      language
    }
  };
}

function isSafeSubtitleLanguageCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function buildSourceSubtitleArgs(selection, outputTemplate, ffmpegLocation = "") {
  if (!selection?.enabled) {
    return [];
  }

  const subtitleTemplate = buildSubtitleOutputTemplate(outputTemplate);
  const args = [
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    `^${escapeRegularExpression(selection.language)}$`,
    "--sub-format",
    "srt/best",
    "--convert-subs",
    "srt",
    "--output",
    `subtitle:${subtitleTemplate}`
  ];

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  return args;
}

function buildSubtitleOutputTemplate(outputTemplate) {
  const template = String(outputTemplate || "%(title)s.%(ext)s");

  return template.includes("%(ext)s")
    ? template.replace(/%\(ext\)s$/, "%(language)s.%(ext)s")
    : `${template}.%(language)s.%(ext)s`;
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createSourceSubtitleArtifacts(options) {
  const {
    downloadsDir,
    mediaPath,
    language,
    width,
    height,
    duration,
    startedAtMs = 0,
    ffmpegCommandParts,
    onProgress,
    spawnImpl,
    renderTimeoutMs
  } = options;
  const subtitlePath = findDownloadedSubtitleFile({
    downloadsDir,
    mediaPath,
    language,
    startedAtMs
  });

  if (!subtitlePath) {
    throw createSourceSubtitleError(
      "The selected source subtitle language was not available when the video was downloaded."
    );
  }

  reportProgress(onProgress, {
    percent: 95,
    stage: "subtitles",
    message: "Preparing the selected source subtitles."
  });

  const transcriptPath = replaceExtension(subtitlePath, ".txt");
  const srt = await fs.promises.readFile(subtitlePath, "utf8");
  const readableTranscript = srtToReadableText(srt);

  await fs.promises.writeFile(transcriptPath, readableTranscript, "utf8");

  reportProgress(onProgress, {
    percent: 96,
    stage: "subtitles",
    message: "Rendering subtitles into the upper third of the video."
  });

  const captionedPath = buildCaptionedVideoPath(mediaPath, language);

  await renderCaptionedVideo({
    inputPath: mediaPath,
    subtitlePath,
    outputPath: captionedPath,
    width,
    height,
    duration,
    ffmpegCommandParts,
    onProgress,
    spawnImpl,
    timeoutMs: renderTimeoutMs
  });

  return {
    fileName: path.basename(captionedPath),
    filePath: captionedPath,
    artifacts: [
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
    ],
    cleanupFilePaths: [mediaPath]
  };
}

function findDownloadedSubtitleFile({ downloadsDir, mediaPath, language, startedAtMs = 0 }) {
  const resolvedDownloadsDir = path.resolve(downloadsDir);
  const mediaStem = path.basename(mediaPath, path.extname(mediaPath));
  const expectedName = `${mediaStem}.${language}.srt`.toLowerCase();
  const acceptedAfter = Math.max(0, startedAtMs - 5000);

  try {
    const candidates = fs
      .readdirSync(resolvedDownloadsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".srt"))
      .map((entry) => {
        const filePath = path.join(resolvedDownloadsDir, entry.name);
        const stats = fs.statSync(filePath);
        const lowerName = entry.name.toLowerCase();
        const sameMedia = lowerName.startsWith(`${mediaStem.toLowerCase()}.`);
        const exactLanguage = lowerName === expectedName;

        return {
          filePath,
          stats,
          score: exactLanguage ? 2 : sameMedia ? 1 : 0
        };
      })
      .filter(
        (candidate) =>
          candidate.score > 0 &&
          candidate.stats.isFile() &&
          candidate.stats.size > 0 &&
          Math.max(candidate.stats.mtimeMs, candidate.stats.ctimeMs) >= acceptedAfter
      )
      .sort(
        (left, right) =>
          right.score - left.score || right.stats.mtimeMs - left.stats.mtimeMs
      );

    return candidates[0]?.filePath || "";
  } catch {
    return "";
  }
}

function srtToReadableText(srt) {
  const cues = String(srt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map(readSrtCue)
    .filter(Boolean);
  const readableCues = [];

  for (const cue of cues) {
    const previous = readableCues.at(-1);

    if (cue === previous) {
      continue;
    }

    readableCues.push(cue);
  }

  return `${readableCues.join("\n\n").trim()}\n`;
}

function readSrtCue(block) {
  const lines = String(block)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (/^\d+$/.test(lines[0] || "")) {
    lines.shift();
  }

  if (/^\d{1,2}:\d{2}:\d{2}[,.]\d+\s+-->\s+/.test(lines[0] || "")) {
    lines.shift();
  }

  return decodeHtmlEntities(
    lines
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]+}/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, codePoint) => safeCharacter(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint) =>
      safeCharacter(Number.parseInt(codePoint, 16))
    );
}

function safeCharacter(codePoint) {
  try {
    return Number.isInteger(codePoint) && codePoint > 0
      ? String.fromCodePoint(codePoint)
      : "";
  } catch {
    return "";
  }
}

function buildCaptionedVideoPath(mediaPath, language) {
  const directory = path.dirname(mediaPath);
  const stem = path.basename(mediaPath, path.extname(mediaPath));
  const safeLanguage = String(language).replace(/[^A-Za-z0-9._-]/g, "-");

  return path.join(directory, `${stem} - subtitled ${safeLanguage}.mp4`);
}

function renderCaptionedVideo(options) {
  const {
    inputPath,
    subtitlePath,
    outputPath,
    height,
    duration,
    onProgress,
    spawnImpl = spawn,
    timeoutMs = 2 * 60 * 60 * 1000,
    signal,
    captionPosition = "upper-third",
    progressStart = 96,
    progressEnd = 99,
    progressStage = "subtitles",
    progressMessage = "Rendering subtitles into the video",
    completionMessage = "Finalizing the captioned video and transcript files."
  } = options;
  const commandParts = options.ffmpegCommandParts || {
    command: "ffmpeg",
    args: []
  };
  const isBottomCenter = captionPosition === "bottom-center";
  const alignment = isBottomCenter ? 2 : 6;
  const marginV = isBottomCenter ? 24 : 96;
  const fontSize = 18;
  const filter = buildSubtitleFilter(subtitlePath, { alignment, marginV, fontSize });
  const args = [
    ...(Array.isArray(commandParts.args) ? commandParts.args : []),
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath
  ];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancelledSubtitleError());
      return;
    }

    const child = spawnImpl(commandParts.command, args, { windowsHide: true });
    let stdoutBuffer = "";
    let stderr = "";
    let startupFailed = false;
    let timedOut = false;
    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill();
    };
    const timeout = Number(timeoutMs) > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer = reportFfmpegProgress(
        chunk.toString(),
        stdoutBuffer,
        duration,
        onProgress,
        {
          progressStart,
          progressEnd,
          progressStage,
          progressMessage
        }
      );
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-12000);
    });

    child.on("error", (error) => {
      startupFailed = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", abort);
      reject(
        createSourceSubtitleError(
          "The bundled caption renderer could not start.",
          { cause: error, commandParts: { command: commandParts.command, args }, stderr }
        )
      );
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", abort);

      if (startupFailed) {
        return;
      }

      if (aborted) {
        reject(createCancelledSubtitleError());
        return;
      }

      if (timedOut) {
        reject(
          createSourceSubtitleError("Rendering subtitles took too long and was stopped.", {
            commandParts: { command: commandParts.command, args },
            stderr
          })
        );
        return;
      }

      if (code !== 0 || !isNonEmptyFile(outputPath)) {
        reject(
          createSourceSubtitleError("The subtitles could not be rendered into the video.", {
            exitCode: code,
            commandParts: { command: commandParts.command, args },
            stderr
          })
        );
        return;
      }

      reportProgress(onProgress, {
        percent: progressEnd,
        stage: progressStage,
        message: completionMessage
      });
      resolve({ commandParts: { command: commandParts.command, args }, stderr });
    });
  });
}

function buildSubtitleFilter(
  subtitlePath,
  { alignment = 6, marginV = 96, fontSize = 18 } = {}
) {
  const escapedPath = escapeFfmpegFilterPath(subtitlePath);
  const style = [
    `Alignment=${alignment}`,
    `MarginV=${marginV}`,
    `FontSize=${fontSize}`,
    "Outline=2",
    "Shadow=1",
    "WrapStyle=2"
  ].join(",");

  return `subtitles=filename='${escapedPath}':force_style='${style}'`;
}

function escapeFfmpegFilterPath(filePath) {
  return String(filePath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;");
}

function reportFfmpegProgress(
  text,
  previousBuffer,
  duration,
  onProgress,
  options = {}
) {
  const lines = `${previousBuffer}${text}`.split(/\r?\n/);
  const nextBuffer = lines.pop() || "";
  const durationSeconds = Number(duration);
  const progressStart = Number(options.progressStart) || 96;
  const progressEnd = Number(options.progressEnd) || 99;
  const progressSpan = Math.max(0, progressEnd - progressStart);

  if (!onProgress || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return nextBuffer;
  }

  for (const line of lines) {
    const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line.trim());

    if (!match) {
      continue;
    }

    const renderedSeconds = Number(match[1]) / 1_000_000;
    const renderedPercent = Math.min(100, (renderedSeconds / durationSeconds) * 100);
    const percent = progressStart + (renderedPercent / 100) * progressSpan;

    reportProgress(onProgress, {
      percent,
      stage: options.progressStage || "subtitles",
      message: `${options.progressMessage || "Rendering subtitles into the video"} (${Math.round(renderedPercent)}%).`
    });
  }

  return nextBuffer;
}

function replaceExtension(filePath, extension) {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}${extension}`
  );
}

function isNonEmptyFile(filePath) {
  try {
    const stats = fs.statSync(filePath);

    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function createSourceSubtitleError(userMessage, details = {}) {
  const error = new Error(userMessage);

  return Object.assign(error, details, { userMessage });
}

function createCancelledSubtitleError() {
  const error = createSourceSubtitleError(
    "Transcription was cancelled. The non-captioned video has been kept."
  );

  error.cancelled = true;
  return error;
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress === "function") {
    onProgress(progress);
  }
}

module.exports = {
  buildCaptionedVideoPath,
  buildSourceSubtitleArgs,
  buildSubtitleFilter,
  buildSubtitleOutputTemplate,
  createSourceSubtitleArtifacts,
  escapeFfmpegFilterPath,
  extractSubtitleLanguages,
  findDownloadedSubtitleFile,
  isSafeSubtitleLanguageCode,
  normalizeSourceSubtitleSelection,
  renderCaptionedVideo,
  srtToReadableText
};
