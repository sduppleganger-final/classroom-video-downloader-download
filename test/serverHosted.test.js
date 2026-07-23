const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");

test("hosted mode runs protected download jobs", async (t) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-server-"));
  t.after(() => fs.rmSync(downloadsDir, { recursive: true, force: true }));

  const app = createApp({
    hostedMode: true,
    accessCode: "class-code",
    downloadsDir,
    startCleanupTimer: false,
    downloadVideo: async (_url, _resolution, jobDownloadsDir, options = {}) => {
      options.onProgress?.({
        percent: 61,
        stage: "downloading",
        message: "Downloading 61%."
      });
      fs.writeFileSync(path.join(jobDownloadsDir, "hosted.mp4"), "hosted-demo");
      return { fileName: "hosted.mp4" };
    }
  });
  const server = await listen(app);
  t.after(() => {
    app.locals.downloadJobs.stopCleanupTimer();
    server.close();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = await fetchJson(`${baseUrl}/api/config`);

  assert.equal(config.hostedMode, true);
  assert.equal(config.accessCodeRequired, true);
  assert.equal(config.downloadMode, "job");
  assert.equal(config.canOpenFileLocation, false);

  const unsupportedFileLocation = await fetch(`${baseUrl}/api/open-file-location`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Classroom-Access-Code": "class-code"
    },
    body: JSON.stringify({ filePath: "/tmp/hosted.mp4" })
  });

  assert.equal(unsupportedFileLocation.status, 404);

  const unauthorized = await fetch(`${baseUrl}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best"
    })
  });

  assert.equal(unauthorized.status, 401);

  const created = await fetchJson(`${baseUrl}/api/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Classroom-Access-Code": "class-code"
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resolution: "best"
    })
  });

  assert.equal(["queued", "working"].includes(created.status), true);
  assert.equal(typeof created.jobId, "string");

  const readyJob = await waitForHostedJob(baseUrl, created.jobId);
  assert.equal(readyJob.status, "complete");
  assert.equal(readyJob.fileName, "hosted.mp4");
  assert.equal(readyJob.progressPercent, 100);
  assert.equal(readyJob.progressStage, "complete");

  const deniedFile = await fetch(`${baseUrl}${readyJob.downloadUrl.split("?")[0]}`);
  assert.equal(deniedFile.status, 403);

  const fileResponse = await fetch(`${baseUrl}${readyJob.downloadUrl}`);

  assert.equal(fileResponse.status, 200);
  assert.equal(await fileResponse.text(), "hosted-demo");
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

async function waitForHostedJob(baseUrl, jobId) {
  const deadline = Date.now() + 1000;

  while (Date.now() <= deadline) {
    const job = await fetchJson(`${baseUrl}/api/downloads/${jobId}`, {
      headers: {
        "X-Classroom-Access-Code": "class-code"
      }
    });

    if (job.status === "complete") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for hosted job ${jobId}.`);
}
