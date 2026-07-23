const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildDiagnosticFileName } = require("./diagnostics");

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

  createJob({ url, resolution }) {
    const now = this.now();
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: null,
      fileName: null,
      downloadToken: crypto.randomBytes(24).toString("hex"),
      error: null,
      diagnosticLog: null,
      diagnosticFileName: null,
      resolutionLabel: resolution.label,
      actualResolutionLabel: null,
      adjustmentMessage: null,
      progressPercent: 0,
      progressStage: "queued",
      message: "Waiting for the next download slot."
    };

    this.jobs.set(job.id, job);
    this.queue.push({ jobId: job.id, url, resolution });
    this.pumpQueue();

    return this.serializeJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);

    return job ? this.serializeJob(job) : null;
  }

  getDownloadPath(jobId, downloadToken) {
    const job = this.jobs.get(jobId);

    if (
      !job ||
      job.status !== "complete" ||
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

  cleanupExpiredJobs() {
    const now = this.now().getTime();

    for (const [jobId, job] of this.jobs) {
      if (!job.expiresAt || Date.parse(job.expiresAt) > now) {
        continue;
      }

      if (this.cleanupFiles && job.fileName) {
        const filePath = path.resolve(this.downloadsDir, job.fileName);

        if (isInsideDirectory(filePath, this.downloadsDir) && fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
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

  async runJob({ jobId, url, resolution }) {
    const job = this.jobs.get(jobId);

    if (!job) {
      return;
    }

    this.activeCount += 1;
    this.updateJob(job, {
      status: "working",
      progressPercent: Math.max(job.progressPercent || 0, 8),
      progressStage: "starting",
      message: "Downloading the selected media."
    });

    try {
      const result = await this.downloadVideo(url, resolution, this.downloadsDir, {
        onProgress: (progress) => {
          this.updateProgress(job, progress);
        }
      });
      const expiresAt = new Date(this.now().getTime() + this.jobTtlMs).toISOString();

      this.updateJob(job, {
        status: "complete",
        fileName: result.fileName,
        actualResolutionLabel: result.actualResolutionLabel || null,
        adjustmentMessage: result.adjustmentMessage || null,
        progressPercent: 100,
        progressStage: "complete",
        expiresAt,
        message: result.adjustmentMessage
          ? `${result.adjustmentMessage} This hosted download expires at ${expiresAt}.`
          : `Ready to save. This hosted download expires at ${expiresAt}.`
      });
    } catch (error) {
      const expiresAt = new Date(this.now().getTime() + this.jobTtlMs).toISOString();

      this.updateJob(job, {
        status: "failed",
        error: error.userMessage || "Could not download a video from that link.",
        diagnosticLog: error.diagnosticLog || null,
        diagnosticFileName: error.diagnosticLog
          ? buildDiagnosticFileName(this.now())
          : null,
        progressStage: "failed",
        expiresAt,
        message: "The download failed."
      });
    } finally {
      this.activeCount -= 1;
      this.pumpQueue();
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
      error: job.error,
      diagnosticLog: job.diagnosticLog,
      diagnosticFileName: job.diagnosticFileName,
      resolutionLabel: job.resolutionLabel,
      actualResolutionLabel: job.actualResolutionLabel,
      adjustmentMessage: job.adjustmentMessage,
      progressPercent: job.progressPercent,
      progressStage: job.progressStage,
      message: job.message,
      downloadUrl:
        job.status === "complete"
          ? `/api/downloads/${encodeURIComponent(job.id)}/file?token=${job.downloadToken}`
          : null
    };
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
