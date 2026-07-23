const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { createAccessControl } = require("./src/accessControl");
const { createDownloadJobManager } = require("./src/downloadJobs");
const { createFailureDiagnostic, toErrorPayload } = require("./src/diagnostics");
const { buildDownloadOutputTemplate } = require("./src/fileNaming");
const { normalizeResolution } = require("./src/downloadOptions");
const { parseVideoUrl } = require("./src/twitterUrl");
const { getVideoPreview } = require("./src/videoPreview");
const { resolvePackagedBinaryPath } = require("./src/binaryPath");
const { getAvailableDownloadPath } = require("./electron/downloadPath");
const {
  getBundledYtDlpPath,
  getYtDlpCommandCandidates,
  getYtDlpCommandParts,
  getYtDlpExecutablePath,
  hasYtDlp,
  isYtDlpRuntimeUnavailable
} = require("./src/ytdlpCommand");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const ytDlpPrintPrefixes = {
  filePath: "__CVD_FILE__",
  width: "__CVD_WIDTH__",
  height: "__CVD_HEIGHT__",
  progress: "__CVD_PROGRESS__"
};

function createApp(options = {}) {
  const app = express();
  const downloadsDir =
    options.downloadsDir || process.env.DOWNLOADS_DIR || path.join(rootDir, "downloads");
  const finalDownloadsDir =
    options.finalDownloadsDir || process.env.FINAL_DOWNLOADS_DIR || "";
  const hostedMode = options.hostedMode ?? process.env.HOSTED_MODE === "1";
  const accessControl = createAccessControl(
    options.accessCode ?? process.env.CLASSROOM_ACCESS_CODE
  );
  const runDownload = options.downloadVideo || downloadVideo;
  const downloadJobs =
    options.downloadJobs ||
    createDownloadJobManager({
      downloadsDir,
      downloadVideo: runDownload,
      jobTtlMs: options.jobTtlMs ?? process.env.DOWNLOAD_JOB_TTL_MS,
      cleanupIntervalMs: options.cleanupIntervalMs ?? process.env.DOWNLOAD_CLEANUP_INTERVAL_MS,
      cleanupFiles: options.cleanupFiles ?? hostedMode,
      maxConcurrentJobs: options.maxConcurrentJobs ?? process.env.DOWNLOAD_MAX_CONCURRENT_JOBS,
      startCleanupTimer: options.startCleanupTimer
    });

  fs.mkdirSync(downloadsDir, { recursive: true });
  app.locals.hostedMode = hostedMode;
  app.locals.downloadJobs = downloadJobs;

  app.disable("x-powered-by");
  app.use(createCorsMiddleware(options.publicAppOrigin ?? process.env.PUBLIC_APP_ORIGIN));
  app.use(express.json({ limit: "16kb" }));
  app.use((error, _request, response, next) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }

    next(error);
  });
  app.use(express.static(publicDir));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, hostedMode });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      hostedMode,
      accessCodeRequired: accessControl.required,
      downloadMode: hostedMode ? "job" : "direct"
    });
  });

  app.get("/api/downloads/:jobId/file", (request, response) => {
    sendDownloadFile(request, response, downloadJobs);
  });

  app.use("/api", accessControl.middleware);

  app.post("/api/preview", async (request, response) => {
    const videoUrl = typeof request.body?.url === "string" ? request.body.url.trim() : "";
    const parsed = parseVideoUrl(videoUrl);
    const resolution = normalizeResolution(request.body?.resolution);

    if (!parsed.ok) {
      response.status(400).json({ error: parsed.message });
      return;
    }

    if (!resolution.ok) {
      response.status(400).json({ error: resolution.message });
      return;
    }

    try {
      const preview = await getVideoPreview(parsed.normalizedUrl, resolution);

      response.json({
        ...preview,
        resolution: resolution.value,
        resolutionLabel: resolution.label
      });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json(toErrorPayload(error, "Could not load a preview for that link."));
    }
  });

  app.post("/api/download", async (request, response) => {
    const videoUrl = typeof request.body?.url === "string" ? request.body.url.trim() : "";
    const parsed = parseVideoUrl(videoUrl);
    const resolution = normalizeResolution(request.body?.resolution);

    if (!parsed.ok) {
      response.status(400).json({ error: parsed.message });
      return;
    }

    if (!resolution.ok) {
      response.status(400).json({ error: resolution.message });
      return;
    }

    if (hostedMode) {
      const job = downloadJobs.createJob({
        url: parsed.normalizedUrl,
        resolution
      });

      response.status(202).json({
        jobId: job.id,
        status: job.status,
        statusUrl: `/api/downloads/${encodeURIComponent(job.id)}`,
        resolution: resolution.value,
        resolutionLabel: resolution.label,
        message: job.message
      });
      return;
    }

    try {
      const result = await runDownload(parsed.normalizedUrl, resolution, downloadsDir);
      const completedFileName = result.filePath
        ? path.basename(result.filePath)
        : result.fileName;

      const payload = {
        fileName: completedFileName,
        downloadUrl: `/downloads/${encodeURIComponent(completedFileName)}`,
        resolution: resolution.value,
        resolutionLabel: resolution.label,
        actualResolutionLabel: result.actualResolutionLabel || null,
        adjustmentMessage: result.adjustmentMessage || null
      };

      if (finalDownloadsDir) {
        const savedDownload = await saveDirectDownloadToFinalDirectory({
          downloadsDir,
          finalDownloadsDir,
          fileName: completedFileName,
          sourceFilePath: result.filePath
        });

        payload.saved = true;
        payload.savedPath = savedDownload.filePath;
        payload.savedFileName = savedDownload.fileName;
      }

      response.json(payload);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json(toErrorPayload(error, "Could not download a video from that link."));
    }
  });

  app.get("/api/downloads/:jobId", (request, response) => {
    const job = downloadJobs.getJob(request.params.jobId);

    if (!job) {
      response.status(404).json({ error: "Download job not found or expired." });
      return;
    }

    response.json(job);
  });

  app.get("/api/downloads/:jobId/file", (request, response) => {
    const job = downloadJobs.getJob(request.params.jobId);

    if (!job) {
      response.status(404).json({ error: "Download job not found or expired." });
      return;
    }

    if (job.status !== "complete") {
      response.status(409).json({ error: "The download is not ready yet." });
      return;
    }

    const filePath = downloadJobs.getDownloadPath(
      request.params.jobId,
      typeof request.query?.token === "string" ? request.query.token : ""
    );

    if (!filePath) {
      response.status(404).json({ error: "The downloaded file is no longer available." });
      return;
    }

    response.download(filePath, job.fileName);
  });

  if (!hostedMode || options.exposeDownloadsDir === true) {
    app.use(
      "/downloads",
      express.static(downloadsDir, {
        fallthrough: false,
        setHeaders(response, filePath) {
          response.attachment(path.basename(filePath));
        }
      })
    );
  }

  return app;
}

function sendDownloadFile(request, response, downloadJobs) {
  const job = downloadJobs.getJob(request.params.jobId);

  if (!job) {
    response.status(404).json({ error: "Download job not found or expired." });
    return;
  }

  if (job.status !== "complete") {
    response.status(409).json({ error: "The download is not ready yet." });
    return;
  }

  const filePath = downloadJobs.getDownloadPath(
    request.params.jobId,
    typeof request.query?.token === "string" ? request.query.token : ""
  );

  if (!filePath) {
    response.status(403).json({ error: "This download link is invalid or expired." });
    return;
  }

  response.download(filePath, job.fileName);
}

async function saveDirectDownloadToFinalDirectory({
  downloadsDir,
  finalDownloadsDir,
  fileName,
  sourceFilePath
}) {
  const sourcePath = sourceFilePath
    ? path.resolve(sourceFilePath)
    : path.resolve(downloadsDir, fileName);

  if (!isInsideDirectory(sourcePath, downloadsDir)) {
    throw {
      statusCode: 502,
      userMessage: "The extractor returned an unexpected file path.",
      diagnosticLog: createFailureDiagnostic({
        operation: "save direct download",
        userMessage: "The extractor returned an unexpected file path.",
        downloadsDir,
        extra: {
          sourcePath,
          finalDownloadsDir
        }
      })
    };
  }

  if (!fs.existsSync(sourcePath)) {
    throw {
      statusCode: 502,
      userMessage: "The extractor finished, but the downloaded file could not be found.",
      diagnosticLog: createFailureDiagnostic({
        operation: "save direct download",
        userMessage: "The extractor finished, but the downloaded file could not be found.",
        downloadsDir,
        extra: {
          sourcePath,
          finalDownloadsDir
        }
      })
    };
  }

  try {
    fs.mkdirSync(finalDownloadsDir, { recursive: true });
    const filePath = getAvailableDownloadPath(finalDownloadsDir, fileName);

    await fs.promises.copyFile(sourcePath, filePath);

    return {
      fileName: path.basename(filePath),
      filePath
    };
  } catch (error) {
    throw {
      statusCode: 500,
      userMessage: `The file was downloaded, but Windows would not save it to ${finalDownloadsDir}. ${error.message}`,
      diagnosticLog: createFailureDiagnostic({
        operation: "save direct download",
        userMessage: `The file was downloaded, but Windows would not save it to ${finalDownloadsDir}. ${error.message}`,
        downloadsDir,
        error,
        extra: {
          sourcePath,
          finalDownloadsDir
        }
      })
    };
  }
}

function createCorsMiddleware(allowedOrigin) {
  const configuredOrigin = typeof allowedOrigin === "string" ? allowedOrigin.trim() : "";

  return (request, response, next) => {
    if (configuredOrigin) {
      const requestOrigin = request.get("origin");
      const origin =
        configuredOrigin === "*"
          ? requestOrigin || "*"
          : requestOrigin === configuredOrigin
            ? configuredOrigin
            : "";

      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-Classroom-Access-Code"
        );
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
    }

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  };
}

function startServer(port = Number(process.env.PORT || 3000), options = {}) {
  const app = createApp(options);

  return app.listen(port, () => {
    console.log(`Video downloader classroom demo running at http://localhost:${port}`);
  });
}

function downloadVideo(
  url,
  resolution,
  downloadsDir = path.join(rootDir, "downloads"),
  options = {}
) {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    if (resolution.downloadType === "audio" && !hasFfmpeg()) {
      const userMessage =
        "MP3 conversion needs the app's bundled ffmpeg, but it could not be started. Re-download the portable app and check that security software did not block it.";

      reject({
        statusCode: 500,
        userMessage,
        diagnosticLog: createFailureDiagnostic({
          operation: "ffmpeg startup check",
          userMessage,
          url,
          resolution,
          downloadsDir,
          commandParts: {
            command: getFfmpegCheckCommand(),
            args: ["-version"]
          }
        })
      });
      return;
    }

    reportDownloadProgress(onProgress, {
      percent: 5,
      stage: "starting",
      message: "Starting the bundled media extractor."
    });

    const downloadArgs = buildDownloadArgs(url, resolution, downloadsDir);
    const commandCandidates =
      Array.isArray(options.commandCandidates) && options.commandCandidates.length > 0
        ? options.commandCandidates
        : getYtDlpCommandCandidates(downloadArgs);
    const startupFailures = [];
    let settled = false;
    const timeoutMs = normalizeOptionalPositiveNumber(process.env.DOWNLOAD_TIMEOUT_MS);

    startDownloadAttempt(0);

    function startDownloadAttempt(candidateIndex) {
      const commandParts = commandCandidates[candidateIndex] || getYtDlpCommandParts(downloadArgs);
      const child = spawn(commandParts.command, commandParts.args, {
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      let stdoutProgressBuffer = "";
      let stderrProgressBuffer = "";
      let startupFailed = false;
      const timeout = timeoutMs
        ? setTimeout(() => {
            child.kill();
            const userMessage = "The download took too long and was stopped.";

            finish(reject, {
              statusCode: 504,
              userMessage,
              diagnosticLog: buildDownloadDiagnostic({
                operation: "download",
                userMessage,
                url,
                resolution,
                downloadsDir,
                commandParts,
                stdout,
                stderr,
                startedAtMs,
                extra: addStartupFailuresToExtra(startupFailures, {
                  timeoutMs
                })
              })
            });
          }, timeoutMs)
        : null;

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();

        stdout += text;
        stdoutProgressBuffer = reportYtDlpProgress(text, stdoutProgressBuffer, onProgress);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();

        stderr += text;
        stderrProgressBuffer = reportYtDlpProgress(text, stderrProgressBuffer, onProgress);
      });

      child.on("error", (error) => {
        startupFailed = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        startupFailures.push(describeStartupFailure(commandParts, error));

        if (candidateIndex + 1 < commandCandidates.length) {
          reportDownloadProgress(onProgress, {
            percent: 7,
            stage: "starting",
            message: "Primary extractor could not start. Trying backup extractor."
          });
          startDownloadAttempt(candidateIndex + 1);
          return;
        }

        const userMessage =
          "The bundled extractor could not start. Reinstall the app package and try again.";

        finish(reject, {
          statusCode: 500,
          userMessage,
          cause: error,
          diagnosticLog: buildDownloadDiagnostic({
            operation: "download",
            userMessage,
            url,
            resolution,
            downloadsDir,
            commandParts,
            stdout,
            stderr,
            error,
            startedAtMs,
            extra: addStartupFailuresToExtra(startupFailures)
          })
        });
      });

      child.on("close", (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }

        if (settled || startupFailed) {
          return;
        }

        if (code !== 0) {
          if (
            candidateIndex + 1 < commandCandidates.length &&
            isYtDlpRuntimeUnavailable(stderr || stdout)
          ) {
            startupFailures.push(
              describeProcessFailure(commandParts, code, stderr || stdout)
            );
            reportDownloadProgress(onProgress, {
              percent: 7,
              stage: "starting",
              message: "Extractor runtime unavailable. Trying backup extractor."
            });
            startDownloadAttempt(candidateIndex + 1);
            return;
          }

          const mappedError = mapYtDlpError(stderr || stdout);

          mappedError.diagnosticLog = buildDownloadDiagnostic({
            operation: "download",
            userMessage: mappedError.userMessage,
            url,
            resolution,
            downloadsDir,
            commandParts,
            stdout,
            stderr,
            exitCode: code,
            startedAtMs,
            extra: addStartupFailuresToExtra(startupFailures)
          });

          finish(reject, mappedError);
          return;
        }

        reportDownloadProgress(onProgress, {
          percent: 96,
          stage: "finalizing",
          message: "Finalizing the downloaded file."
        });

        const printedOutput = parseYtDlpPrintOutput(stdout);

        const resolvedPath = resolveDownloadedFilePath({
          reportedPath: printedOutput.filePath,
          downloadsDir,
          resolution,
          startedAtMs
        });

        if (!resolvedPath) {
          const userMessage = printedOutput.filePath
            ? "The extractor finished, but the downloaded file could not be found."
            : "The extractor finished without reporting a downloaded file.";

          finish(reject, {
            statusCode: 502,
            userMessage,
            diagnosticLog: buildDownloadDiagnostic({
              operation: "download",
              userMessage,
              url,
              resolution,
              downloadsDir,
              commandParts,
              stdout,
              stderr,
              exitCode: code,
              startedAtMs,
              extra: addStartupFailuresToExtra(startupFailures, {
                reportedPath: printedOutput.filePath,
                printedWidth: printedOutput.width,
                printedHeight: printedOutput.height
              })
            })
          });
          return;
        }

        if (!isInsideDirectory(resolvedPath, downloadsDir)) {
          const userMessage = "The extractor returned an unexpected file path.";

          finish(reject, {
            statusCode: 502,
            userMessage,
            diagnosticLog: buildDownloadDiagnostic({
              operation: "download",
              userMessage,
              url,
              resolution,
              downloadsDir,
              commandParts,
              stdout,
              stderr,
              exitCode: code,
              startedAtMs,
              extra: addStartupFailuresToExtra(startupFailures, {
                resolvedPath
              })
            })
          });
          return;
        }

        finish(resolve, {
          fileName: path.basename(resolvedPath),
          filePath: resolvedPath,
          width: printedOutput.width,
          height: printedOutput.height,
          actualResolutionLabel: buildActualResolutionLabel(printedOutput),
          adjustmentMessage: buildResolutionAdjustmentMessage(resolution, printedOutput)
        });
      });
    }

    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      callback(value);
    }
  });
}

function buildDownloadDiagnostic(details) {
  return createFailureDiagnostic({
    operation: "download",
    ...details
  });
}

function describeStartupFailure(commandParts, error) {
  return {
    label: commandParts?.label || "unlabeled extractor",
    command: commandParts?.command || "not resolved",
    errorName: error?.name || "not set",
    errorCode: error?.code || "not set",
    errorErrno: typeof error?.errno === "undefined" ? "not set" : error.errno,
    errorSyscall: error?.syscall || "not set",
    errorPath: error?.path || "not set",
    errorMessage: error?.message || String(error)
  };
}

function describeProcessFailure(commandParts, exitCode, output) {
  return {
    label: commandParts?.label || "unlabeled extractor",
    command: commandParts?.command || "not resolved",
    errorName: "ProcessExit",
    errorCode: exitCode,
    errorMessage: String(output || "Extractor exited without output.").slice(-2000)
  };
}

function addStartupFailuresToExtra(startupFailures, extra = {}) {
  if (!startupFailures.length) {
    return extra;
  }

  return {
    ...extra,
    startupFailures
  };
}

function buildDownloadArgs(url, resolution, downloadsDir = path.join(rootDir, "downloads")) {
  return [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--newline",
    "--progress",
    "--progress-template",
    `download:${ytDlpPrintPrefixes.progress}%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.eta)s`,
    "--windows-filenames",
    "--format",
    resolution.format,
    "--paths",
    downloadsDir,
    "--output",
    buildDownloadOutputTemplate(),
    ...buildAudioPostProcessArgs(resolution),
    "--print",
    `after_move:${ytDlpPrintPrefixes.filePath}%(filepath)s`,
    "--print",
    `after_move:${ytDlpPrintPrefixes.width}%(width)s`,
    "--print",
    `after_move:${ytDlpPrintPrefixes.height}%(height)s`,
    url
  ];
}

function buildAudioPostProcessArgs(resolution) {
  if (resolution.downloadType !== "audio") {
    return [];
  }

  const args = [
    "--extract-audio",
    "--audio-format",
    resolution.audioFormat || "mp3"
  ];

  if (resolution.audioQuality) {
    args.push("--audio-quality", resolution.audioQuality);
  }

  const ffmpegLocation = getFfmpegLocation();

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  return args;
}

function parseYtDlpPrintOutput(stdout) {
  const lines = String(stdout)
    .replace(/\\r\\n|\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const output = {
    filePath: "",
    width: null,
    height: null
  };

  for (const line of lines) {
    if (line.startsWith(ytDlpPrintPrefixes.filePath)) {
      output.filePath = line.slice(ytDlpPrintPrefixes.filePath.length);
      continue;
    }

    if (line.startsWith(ytDlpPrintPrefixes.width)) {
      output.width = parsePositiveInteger(line.slice(ytDlpPrintPrefixes.width.length));
      continue;
    }

    if (line.startsWith(ytDlpPrintPrefixes.height)) {
      output.height = parsePositiveInteger(line.slice(ytDlpPrintPrefixes.height.length));
    }
  }

  if (!output.filePath) {
    output.filePath = lines.findLast((line) => !line.startsWith("__CVD_")) || "";
  }

  return output;
}

function reportYtDlpProgress(text, previousBuffer, onProgress) {
  if (!onProgress) {
    return "";
  }

  const lines = `${previousBuffer}${text}`.split(/\r?\n/);
  const nextBuffer = lines.pop() || "";

  for (const line of lines) {
    const progress = parseYtDlpProgressOutput(line);

    if (progress) {
      reportDownloadProgress(onProgress, progress);
    }
  }

  return nextBuffer;
}

function parseYtDlpProgressOutput(output) {
  const line = String(output).trim();

  if (!line.startsWith(ytDlpPrintPrefixes.progress)) {
    return null;
  }

  const [
    percentValue,
    downloadedBytesValue,
    totalBytesValue,
    etaValue
  ] = line.slice(ytDlpPrintPrefixes.progress.length).split("|");
  const downloadedBytes = parsePositiveInteger(downloadedBytesValue);
  const totalBytes = parsePositiveInteger(totalBytesValue);
  const parsedPercent = parsePercent(percentValue);
  const percent =
    parsedPercent !== null
      ? parsedPercent
      : downloadedBytes && totalBytes
        ? (downloadedBytes / totalBytes) * 100
        : null;
  const normalizedPercent =
    Number.isFinite(percent) && percent >= 100 ? 94 : clampPercent(percent);
  const etaSeconds = parsePositiveInteger(etaValue);

  if (normalizedPercent === null && !downloadedBytes) {
    return null;
  }

  return {
    percent: normalizedPercent,
    stage: "downloading",
    message: buildProgressMessage({
      percent: normalizedPercent,
      downloadedBytes,
      totalBytes,
      etaSeconds
    })
  };
}

function reportDownloadProgress(onProgress, progress) {
  if (!onProgress) {
    return;
  }

  onProgress(progress);
}

function buildProgressMessage({ percent, downloadedBytes, totalBytes, etaSeconds }) {
  const parts = [];

  if (Number.isFinite(percent)) {
    parts.push(`Downloading ${Math.round(percent)}%`);
  } else {
    parts.push("Downloading media");
  }

  const sizeMessage = buildSizeProgressMessage(downloadedBytes, totalBytes);

  if (sizeMessage) {
    parts.push(sizeMessage);
  }

  if (etaSeconds) {
    parts.push(`${etaSeconds}s remaining`);
  }

  return `${parts.join(" - ")}.`;
}

function buildSizeProgressMessage(downloadedBytes, totalBytes) {
  if (!downloadedBytes) {
    return "";
  }

  if (!totalBytes) {
    return `${formatBytes(downloadedBytes)} downloaded`;
  }

  return `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function buildActualResolutionLabel({ width, height }) {
  const effectiveResolution = getEffectiveResolution({ width, height });

  return effectiveResolution ? `${effectiveResolution}p` : null;
}

function buildResolutionAdjustmentMessage(resolution, actual) {
  if (resolution.downloadType !== "video" || !resolution.height) {
    return null;
  }

  const effectiveResolution = getEffectiveResolution(actual);

  if (!effectiveResolution || effectiveResolution === resolution.height) {
    return null;
  }

  if (effectiveResolution < resolution.height) {
    return `${resolution.height}p was not available. Downloaded the highest available resolution instead: ${effectiveResolution}p.`;
  }

  return `${resolution.height}p was not available. Downloaded ${effectiveResolution}p instead.`;
}

function getEffectiveResolution({ width, height }) {
  if (width && height) {
    return Math.min(width, height);
  }

  return height || width || null;
}

function parsePositiveInteger(value) {
  const number = Number.parseInt(String(value).trim(), 10);

  return Number.isFinite(number) && number > 0 ? number : null;
}

function parsePercent(value) {
  const number = Number.parseFloat(String(value).replace("%", "").trim());

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clampPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, Math.min(99, number));
}

function resolveDownloadedFilePath({ reportedPath, downloadsDir, resolution, startedAtMs = 0 }) {
  const candidates = [];
  const seen = new Set();
  const audioExtension =
    resolution.downloadType === "audio" ? `.${resolution.audioFormat || "mp3"}`.toLowerCase() : "";

  function addCandidate(filePath) {
    if (!filePath) {
      return;
    }

    const resolvedPath = path.resolve(filePath);
    const key = resolvedPath.toLowerCase();

    if (seen.has(key) || !isInsideDirectory(resolvedPath, downloadsDir)) {
      return;
    }

    try {
      const stats = fs.statSync(resolvedPath);

      if (stats.isFile() && !isTemporaryDownloadFile(resolvedPath)) {
        seen.add(key);
        candidates.push({ filePath: resolvedPath, stats });
      }
    } catch {
      // The extractor can report an intermediate path that post-processing later renames.
    }
  }

  if (reportedPath) {
    const reportedCandidates = path.isAbsolute(reportedPath)
      ? [reportedPath]
      : [path.resolve(reportedPath), path.resolve(downloadsDir, reportedPath)];

    for (const candidate of reportedCandidates) {
      addCandidate(candidate);

      if (audioExtension) {
        addCandidate(replaceExtension(candidate, audioExtension));
      }
    }
  }

  const recentFiles = findRecentDownloadFiles(downloadsDir, startedAtMs);
  const reportedStem = reportedPath
    ? path.basename(reportedPath, path.extname(reportedPath)).toLowerCase()
    : "";

  if (audioExtension && reportedStem) {
    for (const filePath of recentFiles) {
      const sameStem = path.basename(filePath, path.extname(filePath)).toLowerCase() === reportedStem;
      const sameExtension = path.extname(filePath).toLowerCase() === audioExtension;

      if (sameStem && sameExtension) {
        addCandidate(filePath);
      }
    }
  }

  for (const filePath of recentFiles) {
    if (!audioExtension || path.extname(filePath).toLowerCase() === audioExtension) {
      addCandidate(filePath);
    }
  }

  for (const filePath of recentFiles) {
    addCandidate(filePath);
  }

  candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);

  return candidates[0]?.filePath || "";
}

function findRecentDownloadFiles(downloadsDir, startedAtMs) {
  const earliestAcceptedTime = Math.max(0, startedAtMs - 5000);

  try {
    return fs
      .readdirSync(downloadsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(downloadsDir, entry.name))
      .filter((filePath) => {
        try {
          const stats = fs.statSync(filePath);

          return (
            stats.isFile() &&
            stats.size > 0 &&
            !isTemporaryDownloadFile(filePath) &&
            Math.max(stats.mtimeMs, stats.ctimeMs) >= earliestAcceptedTime
          );
        } catch {
          return false;
        }
      })
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  } catch {
    return [];
  }
}

function replaceExtension(filePath, extension) {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}${extension}`
  );
}

function isTemporaryDownloadFile(filePath) {
  return /\.(part|temp|tmp|ytdl)$/i.test(filePath);
}

function hasFfmpeg() {
  const command = getFfmpegCheckCommand();
  const result = spawnSync(command, ["-version"], {
    stdio: "ignore",
    windowsHide: true
  });

  return !result.error && result.status === 0;
}

function getFfmpegCheckCommand() {
  const ffmpegLocation = getFfmpegLocation();

  if (!ffmpegLocation) {
    return "ffmpeg";
  }

  try {
    if (fs.existsSync(ffmpegLocation) && fs.statSync(ffmpegLocation).isDirectory()) {
      return path.join(ffmpegLocation, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    }
  } catch {
    return ffmpegLocation;
  }

  return ffmpegLocation;
}

function getFfmpegLocation() {
  return process.env.FFMPEG_LOCATION || process.env.FFMPEG_BIN || getBundledFfmpegPath();
}

function getBundledFfmpegPath() {
  try {
    return resolvePackagedBinaryPath(require("ffmpeg-static") || "");
  } catch {
    return "";
  }
}

function isInsideDirectory(filePath, directory) {
  const resolvedDirectory = path.resolve(directory);
  const relativePath = path.relative(resolvedDirectory, filePath);

  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function mapYtDlpError(output) {
  const lower = output.toLowerCase();

  if (lower.includes("no module named yt_dlp")) {
    return {
      statusCode: 500,
      userMessage:
        "The bundled extractor is missing. Reinstall the app package and try again."
    };
  }

  if (lower.includes("ffmpeg")) {
    return {
      statusCode: 500,
      userMessage:
        "MP3 conversion needs the app's bundled ffmpeg, but it could not be started. Re-download the portable app and check that security software did not block it."
    };
  }

  if (
    lower.includes("no video") ||
    lower.includes("unsupported url") ||
    lower.includes("unable to extract") ||
    lower.includes("requested format is not available")
  ) {
    return {
      statusCode: 404,
      userMessage:
        "No downloadable video was found for that link and resolution, or the source requires access this demo does not have."
    };
  }

  return {
    statusCode: 502,
    userMessage: "The extractor failed while processing the link."
  };
}

function normalizeOptionalPositiveNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildAudioPostProcessArgs,
  buildDownloadArgs,
  createApp,
  downloadVideo,
  getBundledFfmpegPath,
  getBundledYtDlpPath,
  getFfmpegLocation,
  getYtDlpExecutablePath,
  hasFfmpeg,
  hasYtDlp,
  isInsideDirectory,
  parseYtDlpPrintOutput,
  parseYtDlpProgressOutput,
  buildActualResolutionLabel,
  buildResolutionAdjustmentMessage,
  mapYtDlpError,
  resolveDownloadedFilePath,
  startServer
};
