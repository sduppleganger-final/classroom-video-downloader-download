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

test("cancels active Whisper transcription and preserves the downloaded original", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-jobs-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));
  const originalPath = path.join(downloadsDir, "lecture-original.mp4");
  const finalPath = path.join(downloadsDir, "final-copy.mp4");
  const manager = createDownloadJobManager({
    downloadsDir,
    startCleanupTimer: false,
    finalizeResult: async () => ({
      savedFileName: path.basename(finalPath),
      savedPath: finalPath,
      artifacts: []
    }),
    downloadVideo: async (_url, _resolution, _jobDownloadsDir, options = {}) => {
      fs.writeFileSync(originalPath, "original-video");
      fs.writeFileSync(finalPath, "original-video");
      options.onProgress?.({
        percent: 68,
        stage: "transcribing",
        canCancel: true,
        detectedLanguage: "en",
        detectedLanguageName: "English",
        estimatedSecondsRemaining: 120,
        message: "Whisper is transcribing English."
      });

      await new Promise((resolve) => {
        options.signal.addEventListener("abort", resolve, { once: true });
      });

      return {
        cancelled: true,
        fileName: path.basename(originalPath),
        filePath: originalPath,
        artifacts: []
      };
    }
  });
  const created = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: { label: "Best available" },
    transcription: { mode: "whisper", saveOriginal: true }
  });
  const working = await waitForJobProgress(manager, created.id, 68);

  assert.equal(working.canCancel, true);
  assert.equal(working.detectedLanguageName, "English");
  assert.equal(working.estimatedSecondsRemaining, 120);

  const cancellation = manager.cancelJob(created.id);
  assert.equal(cancellation.ok, true);

  const cancelled = await waitForJobStatus(manager, created.id, "cancelled");
  assert.equal(cancelled.fileName, "lecture-original.mp4");
  assert.equal(cancelled.savedPath, finalPath);
  assert.equal(cancelled.canCancel, false);
  assert.match(cancelled.message, /has been kept/);
  assert.match(cancelled.downloadUrl, /\/file\?token=/);
  assert.equal(fs.readFileSync(originalPath, "utf8"), "original-video");
});

test("protects subtitle review media and finalizes corrected cues after a retry", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-review-jobs-"));
  const mediaPath = path.join(downloadsDir, "lecture.mp4");
  const subtitlePath = path.join(downloadsDir, "lecture.en.srt");
  const transcriptPath = path.join(downloadsDir, "lecture.en.txt");
  const outputPath = path.join(downloadsDir, "lecture-captioned.mp4");
  let failRendering = true;
  let finalizeRequest;

  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const manager = createDownloadJobManager({
    downloadsDir,
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, _jobDownloadsDir, options = {}) => {
      assert.equal(options.deferSubtitleReview, true);
      fs.writeFileSync(mediaPath, "video");
      fs.writeFileSync(
        subtitlePath,
        "1\n00:00:00,000 --> 00:00:02,000\nOriginal cue\n",
        "utf8"
      );
      fs.writeFileSync(transcriptPath, "Original cue\n");
      return {
        fileName: path.basename(mediaPath),
        filePath: mediaPath,
        review: {
          mode: "source",
          mediaPath,
          subtitlePath,
          transcriptPath,
          outputPath,
          language: "en",
          languageName: "English",
          duration: 10,
          width: 1280,
          height: 720,
          artifacts: [
            { id: "subtitles", kind: "subtitles", filePath: subtitlePath },
            { id: "transcript", kind: "transcript", filePath: transcriptPath }
          ],
          cleanupFilePaths: [mediaPath]
        }
      };
    },
    finalizeSubtitleReview: async (request) => {
      finalizeRequest = request;

      if (failRendering) {
        throw Object.assign(new Error("renderer failed"), {
          userMessage: "The corrected subtitles could not be rendered.",
          diagnosticLog: "renderer diagnostic"
        });
      }

      fs.writeFileSync(outputPath, "captioned-video");
      return {
        fileName: path.basename(outputPath),
        filePath: outputPath,
        artifacts: request.review.artifacts,
        cleanupFilePaths: request.review.cleanupFilePaths
      };
    }
  });
  const created = manager.createJob({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    resolution: { label: "Best available" },
    transcription: { mode: "source", language: "en", review: true }
  });
  const reviewJob = await waitForJobStatus(manager, created.id, "review");

  assert.equal(reviewJob.review.cues[0].text, "Original cue");
  assert.match(reviewJob.review.mediaUrl, /review-media\?token=/);
  assert.equal(manager.getReviewMediaPath(created.id, "wrong-token"), null);
  assert.equal(
    manager.getReviewMediaPath(created.id, reviewJob.review.token),
    mediaPath
  );
  assert.equal(
    manager.finalizeReview(created.id, {
      token: "wrong-token",
      cueEdits: [{ id: "1", text: "Corrected cue" }],
      style: { position: "top-right", fontSize: 30, color: "#33CC66" }
    }).statusCode,
    403
  );

  const firstAttempt = manager.finalizeReview(created.id, {
    token: reviewJob.review.token,
    cueEdits: [{ id: "1", text: "Corrected cue" }],
    style: { position: "top-right", fontSize: 30, color: "#33CC66" }
  });
  assert.equal(firstAttempt.ok, true);
  const retryJob = await waitForJobStatus(manager, created.id, "review");

  assert.equal(retryJob.error, "The corrected subtitles could not be rendered.");
  assert.equal(retryJob.review.cues[0].text, "Corrected cue");
  assert.match(retryJob.diagnosticLog, /renderer diagnostic/);

  failRendering = false;
  const retry = manager.finalizeReview(created.id, {
    token: retryJob.review.token,
    cueEdits: [{ id: "1", text: "Corrected cue" }],
    style: { position: "top-right", fontSize: 30, color: "#33CC66" }
  });
  assert.equal(retry.ok, true);

  const complete = await waitForJobStatus(manager, created.id, "complete");
  assert.equal(complete.fileName, "lecture-captioned.mp4");
  assert.equal(complete.review, null);
  assert.match(complete.downloadUrl, /\/file\?token=/);
  assert.deepEqual(finalizeRequest.cueEdits, [{ id: "1", text: "Corrected cue" }]);
  assert.deepEqual(finalizeRequest.style, {
    position: "top-right",
    fontSize: 30,
    color: "#33CC66"
  });
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
