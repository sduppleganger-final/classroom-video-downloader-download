const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildDiagnosticFileName } = require("./diagnostics");
const {
  applyCueEdits,
  normalizeSubtitleReviewJobData,
  normalizeSubtitleStyle,
  serializeSubtitleReview
} = require("./subtitleEditor");

const defaultJobTtlMs = 60 * 60 * 1000;
const defaultCleanupIntervalMs = 5 * 60 * 1000;

function createDownloadJobManager(options) {
  return new DownloadJobManager(options);
}

class DownloadJobManager {
  constructor(options = {}) {
    if (typeof options.downloadVideo !== "function") {
      throw new TypeError("downloadVideo is required.");
    }

    this.downloadVideo = options.downloadVideo;
    this.downloadsDir = path.resolve(options.downloadsDir || "downloads");
    this.now = options.now || (() => new Date());
    this.jobTtlMs = normalizePositiveNumber(options.jobTtlMs, defaultJobTtlMs);
    this.cleanupIntervalMs = normalizePositiveNumber(
      options.cleanupIntervalMs,
      defaultCleanupIntervalMs
    );
    this.cleanupFiles = options.cleanupFiles !== false;
    this.finalizeResult =
      typeof options.finalizeResult === "function" ? options.finalizeResult : null;
    this.finalizeSubtitleReview =
      typeof options.finalizeSubtitleReview === "function"
        ? options.finalizeSubtitleReview
        : null;
    this.maxConcurrentJobs = normalizePositiveNumber(options.maxConcurrentJobs, 1);
    this.jobs = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.cleanupTimer = null;

    fs.mkdirSync(this.downloadsDir, { recursive: true });

    if (options.startCleanupTimer !== false) {
      this.startCleanupTimer();
    }
  }

  createJob({
    url,
    resolution,
    transcription = { mode: "none", language: "", saveOriginal: false },
    sourceSubtitle = { enabled: false, language: "" }
  }) {
    const now = this.now();
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: null,
      fileName: null,
      savedFileName: null,
      savedPath: null,
      artifacts: [],
      savedArtifacts: [],
      cleanupFileNames: [],
      downloadToken: crypto.randomBytes(24).toString("hex"),
      error: null,
      diagnosticLog: null,
      diagnosticFileName: null,
      resolutionLabel: resolution.label,
      actualResolutionLabel: null,
      adjustmentMessage: null,
      progressPercent: 0,
      progressStage: "queued",
      canCancel: false,
      cancellationRequested: false,
      detectedLanguage: null,
      detectedLanguageName: null,
      estimatedSecondsRemaining: null,
      reviewData: null,
      message: "Waiting for the next download slot."
    };

    this.jobs.set(job.id, job);
    this.queue.push({
      jobId: job.id,
      url,
      resolution,
      transcription,
      sourceSubtitle
    });
    this.pumpQueue();

    return this.serializeJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);

    return job ? this.serializeJob(job) : null;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);

    if (!job) {
      return { ok: false, statusCode: 404, message: "Download job not found or expired." };
    }

    if (job.status === "queued") {
      this.queue = this.queue.filter((item) => item.jobId !== jobId);
      this.updateJob(job, {
        status: "cancelled",
        progressStage: "cancelled",
        canCancel: false,
        cancellationRequested: true,
        expiresAt: new Date(this.now().getTime() + this.jobTtlMs).toISOString(),
        message: "The queued download was cancelled."
      });
      return { ok: true, job: this.serializeJob(job) };
    }

    if (job.status !== "working") {
      return {
        ok: false,
        statusCode: 409,
        message: "This download is no longer running."
      };
    }

    if (!job.canCancel || !job.abortController) {
      return {
        ok: false,
        statusCode: 409,
        message: "Transcription can be cancelled after the original video finishes downloading."
      };
    }

    if (!job.cancellationRequested) {
      this.updateJob(job, {
        cancellationRequested: true,
        canCancel: false,
        message: "Cancelling transcription and preserving the non-captioned video."
      });
      job.abortController.abort();
    }

    return { ok: true, job: this.serializeJob(job) };
  }

  getDownloadPath(jobId, downloadToken) {
    const job = this.jobs.get(jobId);

    if (
      !job ||
      !isDownloadReadyStatus(job.status) ||
      !job.fileName ||
      !isValidDownloadToken(job, downloadToken)
    ) {
      return null;
    }

    const filePath = path.resolve(this.downloadsDir, job.fileName);

    if (!isInsideDirectory(filePath, this.downloadsDir) || !fs.existsSync(filePath)) {
      return null;
    }

    return filePath;
  }

  getArtifactPath(jobId, downloadToken, artifactId) {
    const job = this.jobs.get(jobId);

    if (!job || !isDownloadReadyStatus(job.status) || !isValidDownloadToken(job, downloadToken)) {
      return null;
    }

    const artifact = job.artifacts.find((item) => item.id === artifactId);

    if (!artifact) {
      return null;
    }

    const filePath = path.resolve(this.downloadsDir, artifact.fileName);

    if (!isInsideDirectory(filePath, this.downloadsDir) || !fs.existsSync(filePath)) {
      return null;
    }

    return filePath;
  }

  getReviewMediaPath(jobId, downloadToken) {
    const job = this.jobs.get(jobId);

    if (
      !job?.reviewData ||
      !["review", "working"].includes(job.status) ||
      !isValidDownloadToken(job, downloadToken)
    ) {
      return null;
    }

    const filePath = path.resolve(job.reviewData.mediaPath);

    if (!isInsideDirectory(filePath, this.downloadsDir) || !isExistingFile(filePath)) {
      return null;
    }

    return filePath;
  }

  finalizeReview(jobId, payload = {}) {
    const job = this.jobs.get(jobId);

    if (!job) {
      return { ok: false, statusCode: 404, message: "Download job not found or expired." };
    }

    if (job.status !== "review" || !job.reviewData) {
      return {
        ok: false,
        statusCode: 409,
        message: "This download is not waiting for subtitle review."
      };
    }

    if (!isValidDownloadToken(job, payload.token)) {
      return { ok: false, statusCode: 403, message: "This subtitle review link is invalid or expired." };
    }

    if (!this.finalizeSubtitleReview) {
      return { ok: false, statusCode: 500, message: "Subtitle rendering is unavailable." };
    }

    try {
      job.reviewData = {
        ...job.reviewData,
        cues: applyCueEdits(job.reviewData.cues, payload.cueEdits),
        style: normalizeSubtitleStyle(payload.style)
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 400,
        message: error.userMessage || "The corrected subtitle settings are invalid."
      };
    }

    this.updateJob(job, {
      status: "working",
      error: null,
      diagnosticLog: null,
      diagnosticFileName: null,
      progressPercent: Math.max(job.progressPercent || 0, 91),
      progressStage: "rendering-subtitles",
      canCancel: false,
      message: "Generating the final video with the corrected subtitles."
    });
    this.runReviewFinalization(job, payload);

    return { ok: true, job: this.serializeJob(job) };
  }

  cleanupExpiredJobs() {
    const now = this.now().getTime();

    for (const [jobId, job] of this.jobs) {
      if (!job.expiresAt || Date.parse(job.expiresAt) > now) {
        continue;
      }

      if (this.cleanupFiles) {
        const fileNames = new Set([
          job.fileName,
          ...job.artifacts.map((artifact) => artifact.fileName),
          ...job.cleanupFileNames,
          ...(job.reviewData
            ? [
                job.reviewData.mediaPath,
                job.reviewData.subtitlePath,
                job.reviewData.transcriptPath,
                job.reviewData.outputPath
              ].map((filePath) => path.basename(filePath))
            : [])
        ]);

        for (const fileName of fileNames) {
          if (!fileName) {
            continue;
          }

          const filePath = path.resolve(this.downloadsDir, fileName);

          if (isInsideDirectory(filePath, this.downloadsDir) && fs.existsSync(filePath)) {
            fs.rmSync(filePath, { force: true });
          }
        }
      }

      this.jobs.delete(jobId);
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredJobs();
    }, this.cleanupIntervalMs);

    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  stopCleanupTimer() {
    if (!this.cleanupTimer) {
      return;
    }

    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  pumpQueue() {
    while (this.activeCount < this.maxConcurrentJobs && this.queue.length > 0) {
      const item = this.queue.shift();
      this.runJob(item);
    }
  }

  async runJob({ jobId, url, resolution, transcription, sourceSubtitle }) {
    const job = this.jobs.get(jobId);

    if (!job) {
      return;
    }

    this.activeCount += 1;
    const abortController = new AbortController();
    job.abortController = abortController;
    this.updateJob(job, {
      status: "working",
      progressPercent: Math.max(job.progressPercent || 0, 8),
      progressStage: "starting",
      message: "Downloading the selected media."
    });

    try {
      const result = await this.downloadVideo(url, resolution, this.downloadsDir, {
        sourceSubtitle,
        transcription,
        deferSubtitleReview: transcription.review === true,
        signal: abortController.signal,
        onProgress: (progress) => {
          this.updateProgress(job, progress);
        }
      });
      const expiresAt = new Date(this.now().getTime() + this.jobTtlMs).toISOString();
      const artifacts = normalizeJobArtifacts(result.artifacts, this.downloadsDir);
      const cleanupFileNames = normalizeCleanupFileNames(
        result.cleanupFilePaths,
        this.downloadsDir
      );
      const reviewData = result.review
        ? normalizeSubtitleReviewJobData(result.review, this.downloadsDir)
        : null;

      if (result.review && !reviewData) {
        throw Object.assign(
          new Error("The subtitle review files could not be prepared safely."),
          { userMessage: "The subtitle review files could not be prepared safely." }
        );
      }

      if (reviewData) {
        this.updateJob(job, {
          status: "review",
          reviewData,
          fileName: null,
          artifacts: [],
          savedArtifacts: [],
          cleanupFileNames,
          actualResolutionLabel: result.actualResolutionLabel || null,
          adjustmentMessage: result.adjustmentMessage || null,
          detectedLanguage: result.detectedLanguage || reviewData.language || null,
          detectedLanguageName:
            result.detectedLanguageName || reviewData.languageName || null,
          estimatedSecondsRemaining: null,
          canCancel: false,
          progressPercent: 90,
          progressStage: "subtitle-review",
          expiresAt,
          message: "Review and correct the subtitles before generating the final video."
        });
        return;
      }

      const finalized = this.finalizeResult
        ? await this.finalizeResult(result, artifacts)
        : {};
      const cancelled = result.cancelled === true;

      this.updateJob(job, {
        status: cancelled ? "cancelled" : "complete",
        fileName: result.fileName,
        savedFileName: finalized.savedFileName || null,
        savedPath: finalized.savedPath || null,
        artifacts,
        savedArtifacts: Array.isArray(finalized.artifacts) ? finalized.artifacts : [],
        cleanupFileNames,
        actualResolutionLabel: result.actualResolutionLabel || null,
        adjustmentMessage: result.adjustmentMessage || null,
        detectedLanguage: result.detectedLanguage || null,
        detectedLanguageName: result.detectedLanguageName || null,
        estimatedSecondsRemaining: null,
        canCancel: false,
        progressPercent: cancelled ? Math.max(job.progressPercent || 0, 55) : 100,
        progressStage: cancelled ? "cancelled" : "complete",
        expiresAt,
        message: cancelled
          ? "Transcription was cancelled. The non-captioned video has been kept."
          : result.adjustmentMessage
            ? `${result.adjustmentMessage} This hosted download expires at ${expiresAt}.`
            : `Ready to save. This hosted download expires at ${expiresAt}.`
      });
    } catch (error) {
      const expiresAt = new Date(this.now().getTime() + this.jobTtlMs).toISOString();
      const cancelled = error?.cancelled === true || abortController.signal.aborted;

      this.updateJob(job, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : error.userMessage || "Could not download a video from that link.",
        diagnosticLog: cancelled ? null : error.diagnosticLog || null,
        diagnosticFileName: !cancelled && error.diagnosticLog
          ? buildDiagnosticFileName(this.now())
          : null,
        canCancel: false,
        estimatedSecondsRemaining: null,
        progressStage: cancelled ? "cancelled" : "failed",
        expiresAt,
        message: cancelled
          ? "The operation was cancelled before a video was ready to keep."
          : "The download failed."
      });
    } finally {
      delete job.abortController;
      this.activeCount -= 1;
      this.pumpQueue();
    }
  }

  async runReviewFinalization(job, payload) {
    try {
      const result = await this.finalizeSubtitleReview({
        review: job.reviewData,
        cueEdits: payload.cueEdits,
        style: payload.style,
        onProgress: (progress) => {
          this.updateProgress(job, progress);
        }
      });
      const expiresAt = new Date(this.now().getTime() + this.jobTtlMs).toISOString();
      const artifacts = normalizeJobArtifacts(result.artifacts, this.downloadsDir);
      const cleanupFileNames = normalizeCleanupFileNames(
        result.cleanupFilePaths,
        this.downloadsDir
      );
      const finalized = this.finalizeResult
        ? await this.finalizeResult(result, artifacts)
        : {};

      this.updateJob(job, {
        status: "complete",
        fileName: result.fileName,
        savedFileName: finalized.savedFileName || null,
        savedPath: finalized.savedPath || null,
        artifacts,
        savedArtifacts: Array.isArray(finalized.artifacts) ? finalized.artifacts : [],
        cleanupFileNames,
        reviewData: null,
        error: null,
        diagnosticLog: null,
        diagnosticFileName: null,
        estimatedSecondsRemaining: null,
        canCancel: false,
        progressPercent: 100,
        progressStage: "complete",
        expiresAt,
        message: `Ready to save. This download expires at ${expiresAt}.`
      });
    } catch (error) {
      this.updateJob(job, {
        status: "review",
        error: error.userMessage || "The corrected subtitles could not be rendered.",
        diagnosticLog: error.diagnosticLog || null,
        diagnosticFileName: error.diagnosticLog
          ? buildDiagnosticFileName(this.now())
          : null,
        canCancel: false,
        progressPercent: 90,
        progressStage: "subtitle-review",
        message: "Rendering failed. Your subtitle review is still available to retry."
      });
    }
  }

  updateJob(job, changes) {
    Object.assign(job, changes, {
      updatedAt: this.now().toISOString()
    });
  }

  updateProgress(job, progress = {}) {
    if (!job || job.status !== "working") {
      return;
    }

    const nextPercent = normalizeProgressPercent(progress.percent);
    const currentPercent = normalizeProgressPercent(job.progressPercent) || 0;
    const changes = {
      progressStage: progress.stage || job.progressStage || "working"
    };

    if (nextPercent !== null) {
      changes.progressPercent = Math.max(currentPercent, nextPercent);
    }

    if (progress.message) {
      changes.message = progress.message;
    } else if (changes.progressPercent) {
      changes.message = `Downloading the selected media (${Math.round(changes.progressPercent)}%).`;
    }

    if (typeof progress.canCancel === "boolean") {
      changes.canCancel = progress.canCancel && !job.cancellationRequested;
    }

    if (progress.detectedLanguage) {
      changes.detectedLanguage = progress.detectedLanguage;
    }

    if (progress.detectedLanguageName) {
      changes.detectedLanguageName = progress.detectedLanguageName;
    }

    if (Number.isFinite(Number(progress.estimatedSecondsRemaining))) {
      changes.estimatedSecondsRemaining = Math.max(
        0,
        Math.round(Number(progress.estimatedSecondsRemaining))
      );
    }

    this.updateJob(job, changes);
  }

  serializeJob(job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
      fileName: job.fileName,
      savedFileName: job.savedFileName,
      savedPath: job.savedPath,
      artifacts: job.artifacts.map((artifact) => ({
        ...job.savedArtifacts.find((saved) => saved.id === artifact.id),
        id: artifact.id,
        kind: artifact.kind,
        fileName: artifact.fileName,
        downloadUrl:
          job.status === "complete"
            ? `/api/downloads/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(artifact.id)}?token=${job.downloadToken}`
            : null
      })),
      error: job.error,
      diagnosticLog: job.diagnosticLog,
      diagnosticFileName: job.diagnosticFileName,
      resolutionLabel: job.resolutionLabel,
      actualResolutionLabel: job.actualResolutionLabel,
      adjustmentMessage: job.adjustmentMessage,
      progressPercent: job.progressPercent,
      progressStage: job.progressStage,
      canCancel: job.canCancel,
      cancellationRequested: job.cancellationRequested,
      detectedLanguage: job.detectedLanguage,
      detectedLanguageName: job.detectedLanguageName,
      estimatedSecondsRemaining: job.estimatedSecondsRemaining,
      message: job.message,
      review:
        job.status === "review" && job.reviewData
          ? serializeSubtitleReview(
              job.reviewData,
              `/api/downloads/${encodeURIComponent(job.id)}/review-media?token=${job.downloadToken}`,
              job.downloadToken
            )
          : null,
      downloadUrl:
        isDownloadReadyStatus(job.status) && job.fileName
          ? `/api/downloads/${encodeURIComponent(job.id)}/file?token=${job.downloadToken}`
          : null
    };
  }
}

function normalizeJobArtifacts(artifacts, downloadsDir) {
  if (!Array.isArray(artifacts)) {
    return [];
  }

  const seenIds = new Set();

  return artifacts.flatMap((artifact) => {
    const id = typeof artifact?.id === "string" ? artifact.id.trim() : "";
    const kind = typeof artifact?.kind === "string" ? artifact.kind.trim() : "";
    const filePath = artifact?.filePath
      ? path.resolve(artifact.filePath)
      : artifact?.fileName
        ? path.resolve(downloadsDir, artifact.fileName)
        : "";

    if (
      !/^[a-z0-9-]{1,40}$/.test(id) ||
      seenIds.has(id) ||
      !kind ||
      !filePath ||
      !isInsideDirectory(filePath, downloadsDir) ||
      !isExistingFile(filePath)
    ) {
      return [];
    }

    seenIds.add(id);

    return [{ id, kind, fileName: path.basename(filePath) }];
  });
}

function normalizeCleanupFileNames(filePaths, downloadsDir) {
  if (!Array.isArray(filePaths)) {
    return [];
  }

  return [...new Set(filePaths.flatMap((filePath) => {
    if (typeof filePath !== "string") {
      return [];
    }

    const resolvedPath = path.resolve(filePath);

    return isInsideDirectory(resolvedPath, downloadsDir)
      ? [path.basename(resolvedPath)]
      : [];
  }))];
}

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeProgressPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, Math.min(100, number));
}

function isValidDownloadToken(job, downloadToken) {
  if (typeof downloadToken !== "string" || !downloadToken) {
    return false;
  }

  const expected = Buffer.from(job.downloadToken);
  const supplied = Buffer.from(downloadToken);

  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function isDownloadReadyStatus(status) {
  return status === "complete" || status === "cancelled";
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isInsideDirectory(filePath, directory) {
  const resolvedDirectory = path.resolve(directory);
  const relativePath = path.relative(resolvedDirectory, filePath);

  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

module.exports = {
  DownloadJobManager,
  createDownloadJobManager,
  isInsideDirectory,
  isValidDownloadToken
};
