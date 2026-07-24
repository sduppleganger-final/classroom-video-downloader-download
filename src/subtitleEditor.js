const fs = require("fs");
const path = require("path");
const {
  renderCaptionedVideo,
  srtToReadableText
} = require("./sourceSubtitles");
const {
  defaultSubtitleStyle,
  getSubtitleRenderStyle,
  hexColorToAss,
  normalizeSubtitleStyle,
  subtitlePositions
} = require("./subtitleStyle");

const maxCueCount = 5000;
const maxCueTextLength = 4000;
const maxEditedTextLength = 1024 * 1024;

async function createSubtitleReview(options) {
  const {
    mode,
    mediaPath,
    subtitlePath,
    transcriptPath,
    outputPath,
    language,
    languageName,
    duration,
    width,
    height,
    artifacts = [],
    cleanupFilePaths = []
  } = options;
  const srt = await fs.promises.readFile(subtitlePath, "utf8");
  const cues = parseSrtCues(srt);

  if (!cues.length) {
    throw createSubtitleEditorError(
      "The transcription completed without editable subtitle cues."
    );
  }

  return {
    mode: mode === "whisper" ? "whisper" : "source",
    mediaPath,
    subtitlePath,
    transcriptPath,
    outputPath,
    language: cleanShortText(language, 64) || "und",
    languageName: cleanShortText(languageName, 120) || null,
    duration: toOptionalPositiveNumber(duration),
    width: toOptionalPositiveNumber(width),
    height: toOptionalPositiveNumber(height),
    cues,
    style: { ...defaultSubtitleStyle },
    artifacts,
    cleanupFilePaths
  };
}

function normalizeSubtitleReviewJobData(review, downloadsDir) {
  if (!review || typeof review !== "object") {
    return null;
  }

  const root = path.resolve(downloadsDir);
  const mediaPath = normalizeReviewPath(review.mediaPath, root, true);
  const subtitlePath = normalizeReviewPath(review.subtitlePath, root, true);
  const transcriptPath = normalizeReviewPath(review.transcriptPath, root, true);
  const outputPath = normalizeReviewPath(review.outputPath, root, false);

  if (!mediaPath || !subtitlePath || !transcriptPath || !outputPath) {
    return null;
  }

  let cues;

  try {
    cues = parseSrtCues(fs.readFileSync(subtitlePath, "utf8"));
  } catch {
    return null;
  }

  if (!cues.length) {
    return null;
  }

  return {
    ...review,
    mediaPath,
    subtitlePath,
    transcriptPath,
    outputPath,
    cues,
    style: normalizeSubtitleStyle(review.style)
  };
}

function serializeSubtitleReview(review, mediaUrl, token) {
  if (!review) {
    return null;
  }

  return {
    mode: review.mode,
    language: review.language,
    languageName: review.languageName,
    duration: review.duration,
    width: review.width,
    height: review.height,
    cues: review.cues.map((cue) => ({ ...cue })),
    style: { ...review.style },
    mediaUrl,
    token
  };
}

async function finalizeSubtitleReview(options) {
  const {
    review,
    cueEdits,
    style,
    signal,
    onProgress,
    ffmpegCommandParts,
    renderImpl = renderCaptionedVideo
  } = options;

  if (!review) {
    throw createSubtitleEditorError("The subtitle review session is no longer available.");
  }

  const cues = applyCueEdits(review.cues, cueEdits);
  const normalizedStyle = normalizeSubtitleStyle(style);
  const srt = formatSrtCues(cues);

  if (!srt.trim()) {
    throw createSubtitleEditorError("Keep at least one subtitle before generating the video.");
  }

  await fs.promises.writeFile(review.subtitlePath, srt, "utf8");
  await fs.promises.writeFile(
    review.transcriptPath,
    srtToReadableText(srt),
    "utf8"
  );

  reportProgress(onProgress, {
    percent: 91,
    stage: "rendering-subtitles",
    message: "Applying the corrected subtitles and selected appearance."
  });

  await renderImpl({
    inputPath: review.mediaPath,
    subtitlePath: review.subtitlePath,
    outputPath: review.outputPath,
    width: review.width,
    height: review.height,
    duration: review.duration,
    ffmpegCommandParts,
    signal,
    onProgress,
    timeoutMs: 0,
    captionStyle: normalizedStyle,
    progressStart: 91,
    progressEnd: 99,
    progressStage: "rendering-subtitles",
    progressMessage: "Rendering the corrected subtitles",
    completionMessage: "Finalizing the captioned video, SRT, and TXT files."
  });

  return {
    fileName: path.basename(review.outputPath),
    filePath: review.outputPath,
    artifacts: review.artifacts,
    cleanupFilePaths: review.cleanupFilePaths,
    detectedLanguage: review.language,
    detectedLanguageName: review.languageName,
    finalizedCues: cues,
    finalizedStyle: normalizedStyle
  };
}

function parseSrtCues(srt) {
  const blocks = String(srt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));

    if (timingIndex < 0) {
      continue;
    }

    const timing = parseTimingLine(lines[timingIndex]);

    if (!timing || timing.endMs <= timing.startMs) {
      continue;
    }

    const text = decodeSubtitleText(lines.slice(timingIndex + 1).join("\n"));

    if (!text) {
      continue;
    }

    cues.push({
      id: String(cues.length + 1),
      startMs: timing.startMs,
      endMs: timing.endMs,
      text
    });

    if (cues.length > maxCueCount) {
      throw createSubtitleEditorError(
        `This transcription has more than ${maxCueCount} cues and cannot be edited safely.`
      );
    }
  }

  return cues;
}

function applyCueEdits(originalCues, cueEdits) {
  if (!Array.isArray(cueEdits)) {
    throw createSubtitleEditorError("The corrected subtitle text was not provided.");
  }

  const originals = new Map(originalCues.map((cue) => [cue.id, cue]));
  const edits = new Map();
  let totalLength = 0;

  for (const edit of cueEdits) {
    const id = typeof edit?.id === "string" ? edit.id : "";

    if (!originals.has(id) || edits.has(id)) {
      throw createSubtitleEditorError("The corrected subtitle list does not match this video.");
    }

    const text = normalizeEditedText(edit.text);

    if (text.length > maxCueTextLength) {
      throw createSubtitleEditorError(
        `A subtitle cue is longer than ${maxCueTextLength} characters.`
      );
    }

    totalLength += text.length;

    if (totalLength > maxEditedTextLength) {
      throw createSubtitleEditorError("The corrected subtitle text is too large.");
    }

    edits.set(id, text);
  }

  if (edits.size !== originals.size) {
    throw createSubtitleEditorError("Every subtitle cue must be included when generating the video.");
  }

  return originalCues.map((cue) => ({
    ...cue,
    text: edits.get(cue.id)
  }));
}

function formatSrtCues(cues) {
  const visibleCues = cues.filter((cue) => cue.text.trim());

  return visibleCues
    .map((cue, index) => [
      String(index + 1),
      `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
      escapeSrtText(cue.text)
    ].join("\n"))
    .join("\n\n") + (visibleCues.length ? "\n" : "");
}

function parseTimingLine(line) {
  const match = /^\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s+-->\s+(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/.exec(
    String(line || "")
  );

  if (!match) {
    return null;
  }

  const startMs = parseSrtTimestamp(match[1]);
  const endMs = parseSrtTimestamp(match[2]);

  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? { startMs, endMs }
    : null;
}

function parseSrtTimestamp(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value);

  if (!match) {
    return NaN;
  }

  const milliseconds = Number(match[4].padEnd(3, "0").slice(0, 3));

  return (
    Number(match[1]) * 60 * 60 * 1000 +
    Number(match[2]) * 60 * 1000 +
    Number(match[3]) * 1000 +
    milliseconds
  );
}

function formatSrtTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const milliseconds = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0")
  ].join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

function decodeSubtitleText(value) {
  return normalizeEditedText(
    String(value || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);/gi, "'")
  );
}

function normalizeEditedText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeSrtText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeReviewPath(filePath, downloadsDir, mustExist) {
  if (typeof filePath !== "string" || !filePath) {
    return "";
  }

  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(downloadsDir, resolvedPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }

  if (!mustExist) {
    return resolvedPath;
  }

  try {
    return fs.statSync(resolvedPath).isFile() ? resolvedPath : "";
  } catch {
    return "";
  }
}

function cleanShortText(value, maximumLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength)
    : "";
}

function toOptionalPositiveNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
}

function createSubtitleEditorError(userMessage, details = {}) {
  return Object.assign(new Error(userMessage), details, { userMessage });
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress === "function") {
    onProgress(progress);
  }
}

module.exports = {
  applyCueEdits,
  createSubtitleReview,
  defaultSubtitleStyle,
  finalizeSubtitleReview,
  formatSrtCues,
  getSubtitleRenderStyle,
  hexColorToAss,
  normalizeSubtitleReviewJobData,
  normalizeSubtitleStyle,
  parseSrtCues,
  serializeSubtitleReview,
  subtitlePositions
};
