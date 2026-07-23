const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const projectRoot = path.join(__dirname, "..");

test("frontend has no visible save-video control", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.equal(indexHtml.includes("result-link"), false);
  assert.equal(indexHtml.includes("Save video"), false);
  assert.equal(appJs.includes("handleResultClick"), false);
  assert.equal(appJs.includes("showDownloadReady"), false);
  assert.equal(stylesCss.includes(".result-link"), false);
});

test("frontend automatically starts browser downloads after completion", () => {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");

  assert.match(appJs, /startAutomaticDownload\(payload\)/);
  assert.match(appJs, /startAutomaticDownload\(\{\s*fileName: job\.fileName,/);
  assert.match(appJs, /downloadFrame\.src = url/);
});

test("frontend surfaces automatic resolution adjustment notices", () => {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");

  assert.match(appJs, /payload\.adjustmentMessage/);
  assert.match(appJs, /job\.adjustmentMessage/);
  assert.match(appJs, /payload\.actualResolutionLabel/);
});

test("frontend shows a download animation and progress bar during downloads", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="download-session"/);
  assert.match(indexHtml, /role="progressbar"/);
  assert.match(indexHtml, /id="download-progress-bar"/);
  assert.match(stylesCss, /\.download-spinner/);
  assert.match(stylesCss, /@keyframes download-spin/);
  assert.match(appJs, /startDownloadSession/);
  assert.match(appJs, /updateDownloadProgress/);
  assert.match(appJs, /job\.progressPercent/);
});

test("frontend stops the download spinner after completion", () => {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(appJs, /downloadSession\.dataset\.state = "working"/);
  assert.match(appJs, /downloadSession\.dataset\.state = "complete"/);
  assert.match(stylesCss, /\.download-session\[data-state="complete"\] \.download-spinner/);
  assert.match(stylesCss, /animation: none/);
  assert.match(stylesCss, /\.download-session\[data-state="complete"\] \.download-progress-track::after/);
});

test("frontend exposes copyable and downloadable diagnostic logs for failures", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="diagnostic-panel"/);
  assert.match(indexHtml, /id="copy-log-button"/);
  assert.match(indexHtml, /id="download-log-button"/);
  assert.match(indexHtml, /id="diagnostic-log"/);
  assert.match(appJs, /showDiagnosticLog\(error\)/);
  assert.match(appJs, /payload\.diagnosticLog/);
  assert.match(appJs, /navigator\.clipboard/);
  assert.match(appJs, /URL\.createObjectURL/);
  assert.match(stylesCss, /\.diagnostic-panel/);
  assert.match(stylesCss, /\.diagnostic-log/);
});

test("desktop completion exposes an open file location action", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");
  const electronMain = fs.readFileSync(path.join(projectRoot, "electron", "main.js"), "utf8");

  assert.match(indexHtml, /id="open-file-location-button"/);
  assert.match(indexHtml, />\s*Open file location\s*</);
  assert.match(appJs, /showFileLocationAction\(payload\.savedPath\)/);
  assert.match(appJs, /appConfig\.canOpenFileLocation/);
  assert.match(appJs, /\/api\/open-file-location/);
  assert.match(stylesCss, /\.file-actions\[hidden\]/);
  assert.match(electronMain, /shell\.showItemInFolder\(filePath\)/);
});

test("frontend offers source transcription discovery and language selection", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="use-source-transcription"/);
  assert.match(indexHtml, />Use transcription from source if available</);
  assert.match(indexHtml, /id="subtitle-language"/);
  assert.match(indexHtml, /id="subtitle-availability"/);
  assert.match(appJs, /payload\.subtitleLanguages/);
  assert.match(appJs, /sourceTranscription: sourceTranscription\.value/);
  assert.match(appJs, /Choose a source subtitle language before downloading/);
  assert.match(stylesCss, /\.checkbox-field input/);
  assert.match(stylesCss, /\.field-subtitle-language\[hidden\]/);
});

test("frontend automatically downloads completed SRT and TXT artifacts", () => {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");

  assert.match(appJs, /artifacts: job\.artifacts/);
  assert.match(appJs, /payload\.artifacts/);
  assert.match(appJs, /triggerAdditionalBrowserDownload/);
  assert.match(appJs, /The SRT subtitles and TXT transcript will follow/);
});
