const form = document.querySelector("#download-form");
const input = document.querySelector("#video-url");
const inputRow = document.querySelector(".input-row");
const resolutionSelect = document.querySelector("#resolution");
const accessCodeField = document.querySelector("#access-code-field");
const accessCodeInput = document.querySelector("#access-code");
const button = document.querySelector("#download-button");
const sourceTranscriptionCheckbox = document.querySelector("#use-source-transcription");
const subtitleLanguageField = document.querySelector("#subtitle-language-field");
const subtitleLanguageSelect = document.querySelector("#subtitle-language");
const subtitleAvailability = document.querySelector("#subtitle-availability");
const previewPanel = document.querySelector(".preview-panel");
const previewVideo = document.querySelector("#preview-video");
const previewTitle = document.querySelector("#preview-title");
const previewMeta = document.querySelector("#preview-meta");
const previewMessage = document.querySelector("#preview-message");
const statusPanel = document.querySelector(".status-panel");
const statusLabel = document.querySelector("#status-label");
const statusMessage = document.querySelector("#status-message");
const downloadSession = document.querySelector("#download-session");
const downloadProgressTrack = document.querySelector(".download-progress-track");
const downloadProgressBar = document.querySelector("#download-progress-bar");
const downloadProgressPercent = document.querySelector("#download-progress-percent");
const downloadProgressDetail = document.querySelector("#download-progress-detail");
const fileActions = document.querySelector("#file-actions");
const openFileLocationButton = document.querySelector("#open-file-location-button");
const diagnosticPanel = document.querySelector("#diagnostic-panel");
const diagnosticLog = document.querySelector("#diagnostic-log");
const diagnosticCopyStatus = document.querySelector("#diagnostic-copy-status");
const copyLogButton = document.querySelector("#copy-log-button");
const downloadLogButton = document.querySelector("#download-log-button");
const apiBaseUrl = normalizeBaseUrl(window.CLASSROOM_VIDEO_API_BASE_URL || "");

let previewDebounce;
let previewController;
let previewPauseTimer;
let previewRequestId = 0;
let downloadFrame;
let progressTimer;
let currentProgressPercent = 0;
let currentSavedPath = "";
let currentDiagnosticFileName = "classroom-video-downloader-log.txt";
let currentSubtitleLanguages = [];
let subtitleDiscoveryState = "idle";
let subtitlePreviewUrl = "";
let appConfig = {
  hostedMode: false,
  accessCodeRequired: false,
  downloadMode: "direct",
  canOpenFileLocation: false
};

input.addEventListener("input", schedulePreview);
input.addEventListener("paste", () => {
  window.setTimeout(schedulePreview, 0);
});
resolutionSelect.addEventListener("change", schedulePreview);
resolutionSelect.addEventListener("change", syncSourceTranscriptionForResolution);
sourceTranscriptionCheckbox.addEventListener("change", handleSourceTranscriptionChange);
window.addEventListener("native-download-complete", (event) => {
  const fileName = event.detail?.fileName || "the file";
  const filePath = event.detail?.filePath;
  const location = filePath ? `Saved to ${filePath}.` : "Saved to your Downloads folder.";

  finishDownloadSession("Saved to your computer.");
  setState("success", "Saved", `${fileName} has been saved. ${location}`);
  showFileLocationAction(filePath);
});
window.addEventListener("native-download-error", (event) => {
  stopDownloadSession();
  hideFileLocationAction();
  clearDiagnosticLog();
  setState("error", "Error", event.detail?.message || "The download could not be saved.");
});

copyLogButton.addEventListener("click", copyDiagnosticLog);
downloadLogButton.addEventListener("click", downloadDiagnosticLog);
openFileLocationButton.addEventListener("click", openSavedFileLocation);

loadConfig();
syncSourceTranscriptionForResolution();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sourceTranscription = getSourceTranscriptionRequest();

  if (!sourceTranscription.ok) {
    setState("error", "Subtitle language needed", sourceTranscription.message);

    if (!subtitleLanguageField.hidden) {
      subtitleLanguageSelect.focus();
    }

    return;
  }

  const resolutionLabel = resolutionSelect.selectedOptions[0]?.textContent || "selected resolution";
  const action = appConfig.hostedMode ? "Starting" : "Working";
  const progressDetail = appConfig.hostedMode
    ? "Creating hosted download job."
    : "Preparing the local download.";

  clearDiagnosticLog();
  hideFileLocationAction();
  startDownloadSession(progressDetail);
  setState("loading", action, `Finding and downloading ${resolutionLabel.toLowerCase()}...`);

  button.disabled = true;
  resolutionSelect.disabled = true;
  accessCodeInput.disabled = true;
  sourceTranscriptionCheckbox.disabled = true;
  subtitleLanguageSelect.disabled = true;

  try {
    const response = await fetchWithClassroomAccess(apiUrl("/api/download"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: input.value,
        resolution: resolutionSelect.value,
        sourceTranscription: sourceTranscription.value
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw createPayloadError(payload, "Download failed.");
    }

    if (response.status === 202 || payload.jobId) {
      await waitForDownloadJob(payload);
    } else if (payload.savedPath) {
      showDownloadSaved(payload);
    } else {
      startAutomaticDownload(payload);
    }
  } catch (error) {
    stopDownloadSession();
    showDiagnosticLog(error);
    setState("error", "Error", error.message);
  } finally {
    button.disabled = false;
    resolutionSelect.disabled = false;
    accessCodeInput.disabled = false;
    syncSourceTranscriptionForResolution();
    subtitleLanguageSelect.disabled =
      subtitleLanguageField.hidden || !sourceTranscriptionCheckbox.checked;
  }
});

async function loadConfig() {
  try {
    const response = await fetch(apiUrl("/api/config"));

    if (!response.ok) {
      return;
    }

    appConfig = {
      ...appConfig,
      ...(await response.json())
    };

    accessCodeField.hidden = !appConfig.accessCodeRequired;
    accessCodeInput.required = appConfig.accessCodeRequired;
    inputRow.classList.toggle("has-access-code", appConfig.accessCodeRequired);

    if (appConfig.hostedMode) {
      setState("idle", "Online", "Paste a supported video link to start a hosted download job.");
    }
  } catch {
    // The app still works in local direct mode if config loading fails.
  }
}

function setState(state, label, message) {
  statusPanel.dataset.state = state;
  statusLabel.textContent = label;
  statusMessage.textContent = message;
}

function syncSourceTranscriptionForResolution() {
  const isVideoDownload = resolutionSelect.value !== "mp3";

  sourceTranscriptionCheckbox.disabled = !isVideoDownload || button.disabled;

  if (isVideoDownload) {
    if (!sourceTranscriptionCheckbox.checked && subtitleDiscoveryState === "audio") {
      subtitleAvailability.textContent = "";
      subtitleDiscoveryState = "idle";
    }
    return;
  }

  sourceTranscriptionCheckbox.checked = false;
  subtitleDiscoveryState = "audio";
  subtitleAvailability.textContent = "Source transcription is available for video downloads only.";
  hideSubtitleLanguageField();
}

function handleSourceTranscriptionChange() {
  if (!sourceTranscriptionCheckbox.checked) {
    subtitleAvailability.textContent = "";
    hideSubtitleLanguageField();
    return;
  }

  const url = input.value.trim();

  if (!url) {
    subtitleDiscoveryState = "waiting";
    subtitleAvailability.textContent = "Enter a video link to check source subtitle languages.";
    hideSubtitleLanguageField();
    return;
  }

  if (subtitlePreviewUrl === url && subtitleDiscoveryState === "ready") {
    showSubtitleLanguageChoices(currentSubtitleLanguages);
    return;
  }

  if (subtitlePreviewUrl === url && subtitleDiscoveryState === "unavailable") {
    subtitleAvailability.textContent = "No source transcription is available for this video.";
    hideSubtitleLanguageField();
    return;
  }

  subtitleDiscoveryState = "checking";
  subtitleAvailability.textContent = "Checking source subtitle languages...";
  hideSubtitleLanguageField();
  schedulePreview();
}

function getSourceTranscriptionRequest() {
  if (!sourceTranscriptionCheckbox.checked) {
    return {
      ok: true,
      value: {
        enabled: false,
        language: ""
      }
    };
  }

  if (subtitleDiscoveryState !== "ready") {
    return {
      ok: false,
      message:
        subtitleDiscoveryState === "checking"
          ? "Wait for the source subtitle language check to finish."
          : "No source transcription is available for this video."
    };
  }

  if (!subtitleLanguageSelect.value) {
    return {
      ok: false,
      message: "Choose a source subtitle language before downloading."
    };
  }

  return {
    ok: true,
    value: {
      enabled: true,
      language: subtitleLanguageSelect.value
    }
  };
}

function showSubtitleLanguageChoices(languages) {
  const previousSelection = subtitleLanguageSelect.value;

  subtitleLanguageSelect.replaceChildren();
  subtitleLanguageSelect.append(new Option("Choose a language", ""));

  for (const language of languages) {
    const sourceLabel =
      language.source === "manual" ? "Creator subtitles" : "Automatic captions";
    const codeLabel = language.name === language.code ? "" : ` (${language.code})`;

    subtitleLanguageSelect.append(
      new Option(`${language.name}${codeLabel} - ${sourceLabel}`, language.code)
    );
  }

  const canRestoreSelection = languages.some(
    (language) => language.code === previousSelection
  );

  subtitleLanguageSelect.value = canRestoreSelection ? previousSelection : "";
  subtitleLanguageField.hidden = false;
  subtitleLanguageSelect.disabled = false;
  subtitleLanguageSelect.required = true;
  subtitleAvailability.textContent = `${languages.length} source subtitle ${languages.length === 1 ? "language is" : "languages are"} available.`;
}

function hideSubtitleLanguageField() {
  subtitleLanguageField.hidden = true;
  subtitleLanguageSelect.disabled = true;
  subtitleLanguageSelect.required = false;
  subtitleLanguageSelect.value = "";
}

function updateSubtitleDiscovery(payload, url) {
  subtitlePreviewUrl = url;
  currentSubtitleLanguages = Array.isArray(payload.subtitleLanguages)
    ? payload.subtitleLanguages
    : [];
  subtitleDiscoveryState = "ready";

  if (!sourceTranscriptionCheckbox.checked) {
    hideSubtitleLanguageField();
    return;
  }

  if (!currentSubtitleLanguages.length) {
    subtitleDiscoveryState = "unavailable";
    subtitleAvailability.textContent = "No source transcription is available for this video.";
    hideSubtitleLanguageField();
    return;
  }

  showSubtitleLanguageChoices(currentSubtitleLanguages);
}

function failSubtitleDiscovery(message) {
  currentSubtitleLanguages = [];
  subtitlePreviewUrl = "";
  subtitleDiscoveryState = "failed";
  hideSubtitleLanguageField();

  if (sourceTranscriptionCheckbox.checked) {
    subtitleAvailability.textContent = message || "Source subtitle languages could not be checked.";
  }
}

function startDownloadSession(detail) {
  window.clearInterval(progressTimer);
  currentProgressPercent = 6;
  downloadSession.hidden = false;
  downloadSession.dataset.state = "working";
  updateDownloadProgress(6, detail || "Preparing download.");

  progressTimer = window.setInterval(() => {
    if (currentProgressPercent >= 92) {
      return;
    }

    const increment = currentProgressPercent < 45 ? 4 : currentProgressPercent < 75 ? 2 : 1;
    updateDownloadProgress(currentProgressPercent + increment);
  }, 900);
}

function updateDownloadProgress(percent, detail) {
  const normalizedPercent = normalizeProgressPercent(percent);

  currentProgressPercent = Math.max(currentProgressPercent, normalizedPercent);
  downloadProgressBar.style.width = `${currentProgressPercent}%`;
  downloadProgressPercent.textContent = `${Math.round(currentProgressPercent)}%`;
  downloadProgressTrack.setAttribute("aria-valuenow", Math.round(currentProgressPercent).toString());

  if (detail) {
    downloadProgressDetail.textContent = detail;
  }
}

function finishDownloadSession(detail) {
  window.clearInterval(progressTimer);
  progressTimer = undefined;
  downloadSession.dataset.state = "complete";
  updateDownloadProgress(100, detail || "Download complete.");
}

function stopDownloadSession() {
  window.clearInterval(progressTimer);
  progressTimer = undefined;
  downloadSession.dataset.state = "idle";
  downloadSession.hidden = true;
  currentProgressPercent = 0;
  downloadProgressBar.style.width = "0%";
  downloadProgressPercent.textContent = "0%";
  downloadProgressTrack.setAttribute("aria-valuenow", "0");
  downloadProgressDetail.textContent = "Preparing download.";
}

function schedulePreview() {
  window.clearTimeout(previewDebounce);

  if (!input.value.trim()) {
    resetPreview("Enter a link to load a short preview.", "The first seconds will appear here.");
    return;
  }

  if (
    sourceTranscriptionCheckbox.checked &&
    input.value.trim() !== subtitlePreviewUrl
  ) {
    subtitleDiscoveryState = "checking";
    subtitleAvailability.textContent = "Checking source subtitle languages...";
    hideSubtitleLanguageField();
  }

  setPreviewState("waiting", "Preparing preview...", "");
  previewDebounce = window.setTimeout(loadPreview, 800);
}

async function loadPreview() {
  const url = input.value.trim();
  const requestId = ++previewRequestId;

  if (previewController) {
    previewController.abort();
  }

  previewController = new AbortController();
  setPreviewState("loading", "Loading preview...", "Fetching a playable stream.");

  if (sourceTranscriptionCheckbox.checked) {
    subtitleDiscoveryState = "checking";
    subtitleAvailability.textContent = "Checking source subtitle languages...";
    hideSubtitleLanguageField();
  }

  try {
    const response = await fetchWithClassroomAccess(apiUrl("/api/preview"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        resolution: resolutionSelect.value
      }),
      signal: previewController.signal
    });

    const payload = await response.json();

    if (requestId !== previewRequestId) {
      return;
    }

    if (!response.ok) {
      throw createPayloadError(payload, "Preview failed.");
    }

    updateSubtitleDiscovery(payload, url);
    showPreview(payload);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    setPreviewState("error", "Preview unavailable", error.message);
    failSubtitleDiscovery("Source subtitle languages could not be checked for this link.");
    showDiagnosticLog(error);
  }
}

function showPreview(payload) {
  window.clearTimeout(previewPauseTimer);

  previewVideo.hidden = false;
  previewVideo.poster = payload.thumbnail || "";
  previewVideo.src = payload.streamUrl;
  previewVideo.currentTime = 0;
  previewVideo.muted = true;

  const duration = formatDuration(payload.duration);
  const meta = [payload.resolutionLabel, duration].filter(Boolean).join(" | ");

  setPreviewState("ready", payload.title || "Video preview", meta || "Preview loaded.");

  previewVideo.onloadedmetadata = () => {
    previewVideo.currentTime = 0;
    const playPromise = previewVideo.play();

    if (playPromise) {
      playPromise.catch(() => {
        previewMessage.textContent = "Preview loaded. Press play to view the first seconds.";
      });
    }

    previewPauseTimer = window.setTimeout(() => {
      previewVideo.pause();
      previewMessage.textContent = "Preview paused after the first seconds.";
    }, 2500);
  };

  previewVideo.load();
}

previewVideo.addEventListener("timeupdate", () => {
  if (previewVideo.currentTime >= 2.5 && !previewVideo.paused) {
    previewVideo.pause();
  }
});

function resetPreview(title, message) {
  ++previewRequestId;

  if (previewController) {
    previewController.abort();
  }

  window.clearTimeout(previewPauseTimer);
  previewVideo.pause();
  previewVideo.onloadedmetadata = null;
  previewVideo.removeAttribute("src");
  previewVideo.removeAttribute("poster");
  previewVideo.hidden = true;
  previewVideo.load();
  currentSubtitleLanguages = [];
  subtitlePreviewUrl = "";

  if (sourceTranscriptionCheckbox.checked) {
    subtitleDiscoveryState = "waiting";
    subtitleAvailability.textContent = "Enter a video link to check source subtitle languages.";
  } else if (resolutionSelect.value !== "mp3") {
    subtitleDiscoveryState = "idle";
    subtitleAvailability.textContent = "";
  }

  hideSubtitleLanguageField();
  setPreviewState("empty", title, message);
}

function setPreviewState(state, title, message) {
  previewPanel.dataset.state = state;
  previewTitle.textContent = title;
  previewMeta.textContent = state === "ready" ? message : "";
  previewMessage.textContent = state === "ready" ? "Playing the first seconds." : message;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");

  return `${minutes}:${remainingSeconds}`;
}

async function waitForDownloadJob(payload) {
  const statusUrl = apiUrl(
    payload.statusUrl || `/api/downloads/${encodeURIComponent(payload.jobId)}`
  );

  setState("loading", "Queued", payload.message || "The download is waiting to start.");
  updateDownloadProgress(payload.progressPercent || 8, payload.message || "Waiting for the next download slot.");

  while (true) {
    await delay(1000);

    const response = await fetchWithClassroomAccess(statusUrl);
    const job = await response.json();

    if (!response.ok) {
      throw createPayloadError(job, "Could not check the download job.");
    }

    if (job.status === "queued") {
      setState("loading", "Queued", job.message || "Waiting for the next download slot.");
      updateDownloadProgress(job.progressPercent || 8, job.message || "Waiting for the next download slot.");
      continue;
    }

    if (job.status === "working") {
      setState("loading", "Downloading", job.message || "The hosted server is downloading it.");
      updateDownloadProgress(
        job.progressPercent || currentProgressPercent,
        job.message || "The hosted server is downloading it."
      );
      continue;
    }

    if (job.status === "complete") {
      finishDownloadSession("Download ready.");
      startAutomaticDownload({
        fileName: job.fileName,
        downloadUrl: job.downloadUrl,
        artifacts: job.artifacts,
        resolutionLabel: job.resolutionLabel,
        actualResolutionLabel: job.actualResolutionLabel,
        adjustmentMessage: job.adjustmentMessage
      });
      return;
    }

    if (job.status === "failed") {
      throw createPayloadError(job, job.error || "The hosted download failed.");
    }

    throw new Error("The hosted download job returned an unknown state.");
  }
}

function createPayloadError(payload = {}, fallbackMessage) {
  const error = new Error(payload.error || fallbackMessage);

  error.diagnosticLog = payload.diagnosticLog || "";
  error.diagnosticFileName = payload.diagnosticFileName || "";

  return error;
}

async function copyDiagnosticLog() {
  const text = diagnosticLog.value;

  if (!text) {
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      diagnosticLog.focus();
      diagnosticLog.select();
      document.execCommand("copy");
      diagnosticLog.setSelectionRange(0, 0);
    }

    diagnosticCopyStatus.textContent = "Log copied.";
  } catch {
    diagnosticLog.focus();
    diagnosticLog.select();
    diagnosticCopyStatus.textContent = "Select the log text and copy it manually.";
  }
}

function downloadDiagnosticLog() {
  const text = diagnosticLog.value;

  if (!text) {
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = currentDiagnosticFileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showDiagnosticLog(error) {
  if (!error?.diagnosticLog) {
    return;
  }

  currentDiagnosticFileName =
    error.diagnosticFileName || `classroom-video-downloader-log-${Date.now()}.txt`;
  diagnosticLog.value = error.diagnosticLog;
  diagnosticCopyStatus.textContent = "";
  diagnosticPanel.hidden = false;
}

function clearDiagnosticLog() {
  diagnosticPanel.hidden = true;
  diagnosticLog.value = "";
  diagnosticCopyStatus.textContent = "";
  currentDiagnosticFileName = "classroom-video-downloader-log.txt";
}

function showDownloadSaved(payload) {
  const fileName = payload.savedFileName || payload.fileName || "The file";
  const notice = payload.adjustmentMessage ? `${payload.adjustmentMessage} ` : "";
  const artifactCount = Array.isArray(payload.artifacts) ? payload.artifacts.length : 0;
  const artifactNotice = artifactCount
    ? ` The SRT subtitles and readable TXT transcript were saved alongside it.`
    : "";

  finishDownloadSession("Saved to your computer.");
  setState(
    "success",
    "Saved",
    `${notice}${fileName} has been saved to ${payload.savedPath}.${artifactNotice}`
  );
  showFileLocationAction(payload.savedPath);
}

function showFileLocationAction(filePath) {
  currentSavedPath = typeof filePath === "string" ? filePath : "";
  fileActions.hidden = !appConfig.canOpenFileLocation || !currentSavedPath;
}

function hideFileLocationAction() {
  currentSavedPath = "";
  fileActions.hidden = true;
}

async function openSavedFileLocation() {
  if (!currentSavedPath || !appConfig.canOpenFileLocation) {
    return;
  }

  openFileLocationButton.disabled = true;

  try {
    const response = await fetchWithClassroomAccess(apiUrl("/api/open-file-location"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ filePath: currentSavedPath })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw createPayloadError(payload, "The file location could not be opened.");
    }

    setState(
      "success",
      "Location opened",
      "Finder or File Explorer opened with the downloaded file selected."
    );
  } catch (error) {
    setState("error", "Could not open location", error.message);
  } finally {
    openFileLocationButton.disabled = false;
  }
}

function startAutomaticDownload(payload) {
  const downloadUrl = apiUrl(payload.downloadUrl);
  const notice = payload.adjustmentMessage ? `${payload.adjustmentMessage} ` : "";
  const resolutionLabel = payload.actualResolutionLabel || payload.resolutionLabel;
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];

  finishDownloadSession("Starting browser save.");
  triggerBrowserDownload(downloadUrl, payload.fileName);

  artifacts.forEach((artifact, index) => {
    window.setTimeout(() => {
      triggerAdditionalBrowserDownload(apiUrl(artifact.downloadUrl), artifact.fileName);
    }, 750 * (index + 1));
  });

  const artifactNotice = artifacts.length
    ? " The SRT subtitles and TXT transcript will follow."
    : "";
  setState(
    "success",
    "Downloading",
    `${notice}${payload.fileName} is being downloaded automatically (${resolutionLabel}).${artifactNotice}`
  );
}

function triggerBrowserDownload(url, fileName) {
  if (!downloadFrame) {
    downloadFrame = document.createElement("iframe");
    downloadFrame.title = "Automatic download";
    downloadFrame.hidden = true;
    document.body.append(downloadFrame);
  }

  downloadFrame.src = url;
}

function triggerAdditionalBrowserDownload(url, fileName) {
  const frame = document.createElement("iframe");

  frame.title = `Automatic download for ${fileName || "transcript file"}`;
  frame.hidden = true;
  document.body.append(frame);
  frame.src = url;

  window.setTimeout(() => frame.remove(), 60000);
}

function fetchWithClassroomAccess(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const accessCode = accessCodeInput.value.trim();

  if (appConfig.accessCodeRequired && accessCode) {
    headers.set("X-Classroom-Access-Code", accessCode);
  }

  return fetch(url, {
    ...options,
    headers
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function apiUrl(pathOrUrl) {
  if (!pathOrUrl || /^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  return `${apiBaseUrl}${pathOrUrl}`;
}

function normalizeBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") : "";
}

function normalizeProgressPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return currentProgressPercent || 0;
  }

  return Math.max(0, Math.min(100, number));
}
