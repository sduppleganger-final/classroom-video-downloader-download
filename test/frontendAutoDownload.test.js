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
  assert.match(appJs, /const completedPayload = \{\s*fileName: job\.fileName,/);
  assert.match(appJs, /startAutomaticDownload\(completedPayload\)/);
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

  assert.match(indexHtml, /id="transcription-source"/);
  assert.match(indexHtml, />Use transcription from source if available</);
  assert.match(indexHtml, /id="subtitle-language"/);
  assert.match(indexHtml, /id="subtitle-availability"/);
  assert.match(appJs, /payload\.subtitleLanguages/);
  assert.match(appJs, /transcription: transcription\.value/);
  assert.match(appJs, /Choose a source subtitle language before downloading/);
  assert.match(stylesCss, /\.transcription-mode input/);
  assert.match(stylesCss, /\.field-subtitle-language\[hidden\]/);
});

test("frontend automatically downloads completed SRT and TXT artifacts", () => {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");

  assert.match(appJs, /artifacts: job\.artifacts/);
  assert.match(appJs, /payload\.artifacts/);
  assert.match(appJs, /triggerAdditionalBrowserDownload/);
  assert.match(appJs, /items\.push\("SRT subtitles"\)/);
  assert.match(appJs, /items\.push\("TXT transcript"\)/);
  assert.match(appJs, /will follow/);
});

test("frontend offers local Whisper with estimates, original-video retention, and cancellation", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="transcription-none"/);
  assert.match(indexHtml, /id="transcription-whisper"/);
  assert.match(indexHtml, /bundled Large v3 Turbo Q5_0 AI model locally/);
  assert.match(indexHtml, /id="save-original-video"[\s\S]*type="checkbox"[\s\S]*checked/);
  assert.match(indexHtml, /id="whisper-estimate"/);
  assert.match(indexHtml, /id="cancel-transcription-button"/);
  assert.match(appJs, /Estimated transcription time on this computer/);
  assert.match(appJs, /mode: "whisper"/);
  assert.match(appJs, /saveOriginal: saveOriginalVideoCheckbox\.checked/);
  assert.match(appJs, /estimatedSecondsRemaining/);
  assert.match(appJs, /Detected language/);
  assert.match(appJs, /\/cancel/);
  assert.match(appJs, /The non-captioned video was kept/);
  assert.match(stylesCss, /\.whisper-estimate/);
  assert.match(stylesCss, /\.cancel-transcription-button/);
});

test("frontend offers synchronized subtitle correction and appearance controls before rendering", () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="review-subtitles"[\s\S]*type="checkbox"[\s\S]*checked/);
  assert.match(indexHtml, /id="subtitle-editor-video"/);
  assert.match(indexHtml, /id="subtitle-cue-list"/);
  assert.match(indexHtml, /name="subtitlePosition"/);
  assert.match(indexHtml, /id="subtitle-font-size"[\s\S]*type="range"/);
  assert.match(indexHtml, /id="subtitle-color"[\s\S]*type="color"/);
  assert.match(indexHtml, /id="generate-captioned-video-button"/);
  assert.match(appJs, /job\.status === "review"/);
  assert.match(appJs, /syncSubtitleCueToPlayback/);
  assert.match(appJs, /cueEdits: session\.cues\.map/);
  assert.match(appJs, /\/finalize/);
  assert.match(appJs, /style: session\.style/);
  assert.match(stylesCss, /\.subtitle-video-stage\[data-position="bottom-center"\]/);
  assert.match(stylesCss, /\.subtitle-cue-row\.is-active/);
  assert.match(stylesCss, /--preview-subtitle-color/);
});
