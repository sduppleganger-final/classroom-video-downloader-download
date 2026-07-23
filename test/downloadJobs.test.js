const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDownloadJobManager } = require("../src/downloadJobs");

test("runs a hosted download job and exposes a job-specific file URL", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-jobs-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const manager = createDownloadJobManager({
    downloadsDir,
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, jobDownloadsDir, options = {}) => {
      options.onProgress?.({
        percent: 44,
        stage: "downloading",
        message: "Downloading 44%."
      });
      fs.writeFileSync(path.join(jobDownloadsDir, "lecture.mp4"), "demo");
      return {
        fileName: "lecture.mp4",
        actualResolutionLabel: "720p",
        adjustmentMessage:
          "1080p was not available. Downloaded the highest available resolution instead: 720p."
      };
    }
  });

  const job = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: {
      label: "720p or lower"
    }
  });

  const readyJob = await waitForJobStatus(manager, job.id, "complete");

  assert.equal(readyJob.fileName, "lecture.mp4");
  assert.equal(readyJob.resolutionLabel, "720p or lower");
  assert.equal(readyJob.actualResolutionLabel, "720p");
  assert.equal(readyJob.progressPercent, 100);
  assert.equal(readyJob.progressStage, "complete");
  assert.equal(
    readyJob.adjustmentMessage,
    "1080p was not available. Downloaded the highest available resolution instead: 720p."
  );
  assert.match(readyJob.message, /1080p was not available/);
  assert.match(readyJob.downloadUrl, new RegExp(`^/api/downloads/${job.id}/file\\?token=`));

  const downloadUrl = new URL(`http://example.test${readyJob.downloadUrl}`);
  const token = downloadUrl.searchParams.get("token");

  assert.equal(manager.getDownloadPath(job.id, "wrong-token"), null);
  assert.equal(fs.readFileSync(manager.getDownloadPath(job.id, token), "utf8"), "demo");
});

test("exposes hosted job progress while a download is running", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-jobs-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  let releaseDownload;
  const downloadCanFinish = new Promise((resolve) => {
    releaseDownload = resolve;
  });

  const manager = createDownloadJobManager({
    downloadsDir,
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, jobDownloadsDir, options = {}) => {
      options.onProgress?.({
        percent: 57,
        stage: "downloading",
        message: "Downloading 57%."
      });

      await downloadCanFinish;
      fs.writeFileSync(path.join(jobDownloadsDir, "lecture.mp4"), "demo");
      return { fileName: "lecture.mp4" };
    }
  });

  const job = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: {
      label: "Best available"
    }
  });

  const workingJob = await waitForJobProgress(manager, job.id, 57);

  assert.equal(workingJob.status, "working");
  assert.equal(workingJob.progressPercent, 57);
  assert.equal(workingJob.progressStage, "downloading");
  assert.equal(workingJob.message, "Downloading 57%.");

  releaseDownload();

  const readyJob = await waitForJobStatus(manager, job.id, "complete");
  assert.equal(readyJob.progressPercent, 100);
});

test("records a failed hosted download job with a classroom-facing error", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-jobs-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const manager = createDownloadJobManager({
    downloadsDir,
    startCleanupTimer: false,
    downloadVideo: async () => {
      throw {
        userMessage: "No downloadable video was found.",
        diagnosticLog: "Classroom Video Downloader diagnostic log\nRequested format failed."
      };
    }
  });

  const job = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: {
      label: "Best available"
    }
  });

  const failedJob = await waitForJobStatus(manager, job.id, "failed");

  assert.equal(failedJob.error, "No downloadable video was found.");
  assert.match(failedJob.diagnosticLog, /Requested format failed/);
  assert.match(failedJob.diagnosticFileName, /^classroom-video-downloader-log-/);
  assert.equal(failedJob.downloadUrl, null);
});

test("cleans up expired hosted job files when cleanup is enabled", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-jobs-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  let currentTime = new Date(2026, 5, 30, 10, 0, 0);
  const manager = createDownloadJobManager({
    downloadsDir,
    jobTtlMs: 1000,
    startCleanupTimer: false,
    now: () => currentTime,
    downloadVideo: async (_url, _resolution, jobDownloadsDir) => {
      fs.writeFileSync(path.join(jobDownloadsDir, "temporary.mp4"), "demo");
      fs.writeFileSync(path.join(jobDownloadsDir, "temporary.en.srt"), "subtitle");
      fs.writeFileSync(path.join(jobDownloadsDir, "temporary.en.txt"), "transcript");
      fs.writeFileSync(path.join(jobDownloadsDir, "temporary-source.mp4"), "source");
      return {
        fileName: "temporary.mp4",
        artifacts: [
          {
            id: "subtitles",
            kind: "subtitles",
            filePath: path.join(jobDownloadsDir, "temporary.en.srt")
          },
          {
            id: "transcript",
            kind: "transcript",
            filePath: path.join(jobDownloadsDir, "temporary.en.txt")
          }
        ],
        cleanupFilePaths: [path.join(jobDownloadsDir, "temporary-source.mp4")]
      };
    }
  });

  const job = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: {
      label: "Best available"
    }
  });

  await waitForJobStatus(manager, job.id, "complete");
  const filePath = path.join(downloadsDir, "temporary.mp4");
  const subtitlePath = path.join(downloadsDir, "temporary.en.srt");
  const transcriptPath = path.join(downloadsDir, "temporary.en.txt");
  const sourcePath = path.join(downloadsDir, "temporary-source.mp4");
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(subtitlePath), true);
  assert.equal(fs.existsSync(transcriptPath), true);
  assert.equal(fs.existsSync(sourcePath), true);

  currentTime = new Date(2026, 5, 30, 10, 0, 2);
  manager.cleanupExpiredJobs();

  assert.equal(manager.getJob(job.id), null);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(subtitlePath), false);
  assert.equal(fs.existsSync(transcriptPath), false);
  assert.equal(fs.existsSync(sourcePath), false);
});

function waitForJobStatus(manager, jobId, expectedStatus) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;

    function check() {
      const job = manager.getJob(jobId);

      if (job?.status === expectedStatus) {
        resolve(job);
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for job ${jobId} to become ${expectedStatus}.`));
        return;
      }

      setTimeout(check, 10);
    }

    check();
  });
}

function waitForJobProgress(manager, jobId, expectedProgress) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;

    function check() {
      const job = manager.getJob(jobId);

      if (job?.progressPercent >= expectedProgress) {
        resolve(job);
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for job ${jobId} to report progress.`));
        return;
      }

      setTimeout(check, 10);
    }

    check();
  });
}
