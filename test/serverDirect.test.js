const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");

test("direct desktop mode saves completed downloads to a final downloads folder", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));
  let openedFilePath = "";

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    openFileLocation: async (filePath) => {
      openedFilePath = filePath;
    },
    downloadVideo: async (_url, _resolution, downloadsDir) => {
      fs.writeFileSync(path.join(downloadsDir, "lecture.mp3"), "audio-demo");
      return { fileName: "lecture.mp3" };
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const payload = await fetchJson(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "mp3"
    })
  });

  assert.equal(payload.saved, true);
  assert.equal(payload.savedFileName, "lecture.mp3");
  assert.equal(payload.savedPath, path.join(finalDownloadsDir, "lecture.mp3"));
  assert.equal(fs.readFileSync(payload.savedPath, "utf8"), "audio-demo");
  assert.equal(fs.readFileSync(path.join(workingDownloadsDir, "lecture.mp3"), "utf8"), "audio-demo");

  const config = await fetchJson(`http://127.0.0.1:${server.address().port}/api/config`);
  assert.equal(config.canOpenFileLocation, true);

  const openResult = await fetchJson(
    `http://127.0.0.1:${server.address().port}/api/open-file-location`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ filePath: payload.savedPath })
    }
  );

  assert.equal(openResult.opened, true);
  assert.equal(openedFilePath, fs.realpathSync(payload.savedPath));
});

test("open file location rejects paths outside the final downloads folder", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-outside-"));
  const outsideFilePath = path.join(outsideDir, "outside.mp4");
  let opened = false;

  fs.writeFileSync(outsideFilePath, "outside");

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    openFileLocation: async () => {
      opened = true;
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/open-file-location`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ filePath: outsideFilePath })
    }
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "The saved download could not be found.");
  assert.equal(opened, false);
});

test("direct desktop mode returns resolution adjustment notices", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    downloadVideo: async (_url, _resolution, downloadsDir) => {
      fs.writeFileSync(path.join(downloadsDir, "lecture.mp4"), "video-demo");
      return {
        fileName: "lecture.mp4",
        actualResolutionLabel: "720p",
        adjustmentMessage:
          "1080p was not available. Downloaded the highest available resolution instead: 720p."
      };
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const payload = await fetchJson(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "1080"
    })
  });

  assert.equal(payload.actualResolutionLabel, "720p");
  assert.equal(
    payload.adjustmentMessage,
    "1080p was not available. Downloaded the highest available resolution instead: 720p."
  );
});

test("direct desktop mode saves from the actual resolved file path", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    downloadVideo: async (_url, _resolution, downloadsDir) => {
      const actualPath = path.join(downloadsDir, "lecture.mp3");

      fs.writeFileSync(actualPath, "audio-demo");

      return {
        fileName: "lecture.webm",
        filePath: actualPath
      };
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const payload = await fetchJson(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "mp3"
    })
  });

  assert.equal(payload.fileName, "lecture.mp3");
  assert.equal(payload.savedFileName, "lecture.mp3");
  assert.equal(payload.savedPath, path.join(finalDownloadsDir, "lecture.mp3"));
  assert.equal(fs.readFileSync(payload.savedPath, "utf8"), "audio-demo");
});

test("direct desktop mode saves a captioned video with SRT and TXT artifacts", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));
  let receivedSourceSubtitle;

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    downloadVideo: async (_url, _resolution, downloadsDir, options) => {
      receivedSourceSubtitle = options.sourceSubtitle;
      const videoPath = path.join(downloadsDir, "lecture - subtitled he.mp4");
      const subtitlePath = path.join(downloadsDir, "lecture.he.srt");
      const transcriptPath = path.join(downloadsDir, "lecture.he.txt");

      fs.writeFileSync(videoPath, "captioned-video");
      fs.writeFileSync(subtitlePath, "subtitle");
      fs.writeFileSync(transcriptPath, "transcript");

      return {
        fileName: path.basename(videoPath),
        filePath: videoPath,
        artifacts: [
          { id: "subtitles", kind: "subtitles", filePath: subtitlePath },
          { id: "transcript", kind: "transcript", filePath: transcriptPath }
        ]
      };
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const payload = await fetchJson(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best",
      sourceTranscription: {
        enabled: true,
        language: "he"
      }
    })
  });

  assert.deepEqual(receivedSourceSubtitle, { enabled: true, language: "he" });
  assert.equal(fs.readFileSync(payload.savedPath, "utf8"), "captioned-video");
  assert.deepEqual(
    payload.artifacts.map((artifact) => [artifact.id, path.basename(artifact.savedPath)]),
    [
      ["subtitles", "lecture.he.srt"],
      ["transcript", "lecture.he.txt"]
    ]
  );
  assert.equal(fs.readFileSync(payload.artifacts[0].savedPath, "utf8"), "subtitle");
  assert.equal(fs.readFileSync(payload.artifacts[1].savedPath, "utf8"), "transcript");
});

test("direct mode rejects source transcription for MP3 downloads", async (t) => {
  const app = createApp({ hostedMode: false });
  const server = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "mp3",
      sourceTranscription: {
        enabled: true,
        language: "en"
      }
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "Source subtitles can only be added to a video download.");
});

test("direct Whisper mode saves captioned, transcript, subtitle, and original files through a job", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));
  let receivedTranscription;

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    whisperStatus: { available: true, modelSize: 487601967 },
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, downloadsDir, options) => {
      receivedTranscription = options.transcription;
      options.onProgress?.({
        percent: 75,
        stage: "transcribing",
        canCancel: true,
        detectedLanguage: "he",
        detectedLanguageName: "Hebrew",
        message: "Whisper is transcribing Hebrew."
      });
      const captionedPath = path.join(downloadsDir, "lecture - Whisper captioned he.mp4");
      const originalPath = path.join(downloadsDir, "lecture.mp4");
      const subtitlePath = path.join(downloadsDir, "lecture.he.srt");
      const transcriptPath = path.join(downloadsDir, "lecture.he.txt");

      fs.writeFileSync(captionedPath, "captioned");
      fs.writeFileSync(originalPath, "original");
      fs.writeFileSync(subtitlePath, "subtitles");
      fs.writeFileSync(transcriptPath, "transcript");

      return {
        fileName: path.basename(captionedPath),
        filePath: captionedPath,
        detectedLanguage: "he",
        detectedLanguageName: "Hebrew",
        artifacts: [
          { id: "subtitles", kind: "subtitles", filePath: subtitlePath },
          { id: "transcript", kind: "transcript", filePath: transcriptPath },
          { id: "original-video", kind: "original-video", filePath: originalPath }
        ]
      };
    }
  });
  const server = await listen(app);
  t.after(() => {
    app.locals.downloadJobs.stopCleanupTimer();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best",
      transcription: { mode: "whisper", saveOriginal: true }
    })
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 202);
  const ready = await waitForLocalJob(baseUrl, created.jobId, "complete");

  assert.deepEqual(receivedTranscription, {
    mode: "whisper",
    language: "auto",
    saveOriginal: true
  });
  assert.equal(ready.detectedLanguageName, "Hebrew");
  assert.equal(fs.readFileSync(ready.savedPath, "utf8"), "captioned");
  assert.deepEqual(
    ready.artifacts.map((artifact) => artifact.id),
    ["subtitles", "transcript", "original-video"]
  );
  assert.equal(
    fs.readFileSync(
      ready.artifacts.find((artifact) => artifact.id === "original-video").savedPath,
      "utf8"
    ),
    "original"
  );
});

test("direct Whisper cancellation keeps and exposes the downloaded original video", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-final-"));

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    whisperStatus: { available: true, modelSize: 487601967 },
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, downloadsDir, options) => {
      const originalPath = path.join(downloadsDir, "lecture original.mp4");

      fs.writeFileSync(originalPath, "original-kept-after-cancel");
      options.onProgress?.({
        percent: 70,
        stage: "transcribing",
        canCancel: true,
        estimatedSecondsRemaining: 90,
        message: "Whisper is transcribing locally."
      });

      await new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }

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
  const server = await listen(app);
  t.after(() => {
    app.locals.downloadJobs.stopCleanupTimer();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetchJson(`${baseUrl}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best",
      transcription: { mode: "whisper", saveOriginal: false }
    })
  });

  const cancellable = await waitForLocalJob(
    baseUrl,
    created.jobId,
    "working",
    (job) => job.canCancel === true
  );
  assert.equal(cancellable.estimatedSecondsRemaining, 90);

  const cancelResponse = await fetch(
    `${baseUrl}/api/downloads/${created.jobId}/cancel`,
    { method: "POST" }
  );
  const cancellation = await cancelResponse.json();

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancellation.cancellationRequested, true);

  const cancelled = await waitForLocalJob(baseUrl, created.jobId, "cancelled");

  assert.equal(cancelled.fileName, "lecture original.mp4");
  assert.match(cancelled.downloadUrl, /\/file\?token=/);
  assert.equal(
    fs.readFileSync(cancelled.savedPath, "utf8"),
    "original-kept-after-cancel"
  );
});

test("direct mode serves a protected subtitle editor and finalizes its corrected video", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-review-working-"));
  const finalDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-review-final-"));
  let finalizerRequest;

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
    fs.rmSync(finalDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    finalDownloadsDir,
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, downloadsDir, options) => {
      assert.equal(options.deferSubtitleReview, true);
      const mediaPath = path.join(downloadsDir, "lecture.mp4");
      const subtitlePath = path.join(downloadsDir, "lecture.en.srt");
      const transcriptPath = path.join(downloadsDir, "lecture.en.txt");

      fs.writeFileSync(mediaPath, "review-video");
      fs.writeFileSync(
        subtitlePath,
        "1\n00:00:00,500 --> 00:00:02,500\nOriginal cue\n",
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
          outputPath: path.join(downloadsDir, "lecture-captioned.mp4"),
          language: "en",
          languageName: "English",
          duration: 15,
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
      finalizerRequest = request;
      fs.writeFileSync(request.review.outputPath, "corrected-captioned-video");
      fs.writeFileSync(request.review.subtitlePath, "corrected-srt");
      fs.writeFileSync(request.review.transcriptPath, "corrected-transcript");
      return {
        fileName: path.basename(request.review.outputPath),
        filePath: request.review.outputPath,
        artifacts: request.review.artifacts,
        cleanupFilePaths: request.review.cleanupFilePaths
      };
    }
  });
  const server = await listen(app);
  t.after(() => {
    app.locals.downloadJobs.stopCleanupTimer();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best",
      transcription: { mode: "source", language: "en", review: true }
    })
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 202);
  const review = await waitForLocalJob(baseUrl, created.jobId, "review");
  assert.equal(review.review.cues[0].text, "Original cue");

  const deniedMedia = await fetch(
    `${baseUrl}/api/downloads/${created.jobId}/review-media?token=wrong`
  );
  assert.equal(deniedMedia.status, 403);

  const mediaResponse = await fetch(`${baseUrl}${review.review.mediaUrl}`);
  assert.equal(mediaResponse.status, 200);
  assert.equal(await mediaResponse.text(), "review-video");

  const finalizeResponse = await fetch(
    `${baseUrl}/api/downloads/${created.jobId}/finalize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: review.review.token,
        cueEdits: [{ id: "1", text: "Corrected cue" }],
        style: { position: "top-left", fontSize: 26, color: "#FFCC00" }
      })
    }
  );
  assert.equal(finalizeResponse.status, 202);

  const complete = await waitForLocalJob(baseUrl, created.jobId, "complete");
  assert.equal(fs.readFileSync(complete.savedPath, "utf8"), "corrected-captioned-video");
  assert.deepEqual(finalizerRequest.cueEdits, [{ id: "1", text: "Corrected cue" }]);
  assert.deepEqual(finalizerRequest.style, {
    position: "top-left",
    fontSize: 26,
    color: "#FFCC00"
  });
});

test("direct desktop mode returns diagnostic logs for failed downloads", async (t) => {
  const workingDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-working-"));

  t.after(() => {
    fs.rmSync(workingDownloadsDir, { recursive: true, force: true });
  });

  const app = createApp({
    hostedMode: false,
    downloadsDir: workingDownloadsDir,
    downloadVideo: async () => {
      throw {
        statusCode: 500,
        userMessage: "The bundled extractor could not start. Reinstall the app package and try again.",
        diagnosticLog: "Classroom Video Downloader diagnostic log\nSpawn error code: ENOENT"
      };
    }
  });
  const server = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best"
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(
    payload.error,
    "The bundled extractor could not start. Reinstall the app package and try again."
  );
  assert.match(payload.diagnosticLog, /Spawn error code: ENOENT/);
  assert.match(payload.diagnosticFileName, /^classroom-video-downloader-log-/);
});

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();

  assert.equal(response.ok, true, payload.error || `Request failed: ${response.status}`);

  return payload;
}

async function waitForLocalJob(baseUrl, jobId, expectedStatus, predicate = () => true) {
  const deadline = Date.now() + 2000;

  while (Date.now() <= deadline) {
    const response = await fetch(`${baseUrl}/api/downloads/${jobId}`);
    const job = await response.json();

    if (job.status === expectedStatus && predicate(job)) {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${jobId} to become ${expectedStatus}.`);
}
