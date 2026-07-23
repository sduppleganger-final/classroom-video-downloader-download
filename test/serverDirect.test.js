const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");

test("direct desktop mode saves completed downloads to a final downloads folder", async (t) => {
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
