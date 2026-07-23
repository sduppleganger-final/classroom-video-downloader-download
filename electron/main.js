const path = require("path");
const fs = require("fs");
const { app: electronApp, BrowserWindow, dialog, shell } = require("electron");
const { createApp, hasFfmpeg, hasWhisper, hasYtDlp } = require("../server");
const { getAvailableDownloadPath } = require("./downloadPath");

let localServer;
let mainWindow;
let downloadHandlerRegistered = false;
const isSmokeTest =
  process.env.ELECTRON_SMOKE_TEST === "1" ||
  process.argv.includes("--smoke-test") ||
  electronApp.commandLine.hasSwitch("smoke-test");

electronApp.setAppUserModelId("classroom.video.downloader");
electronApp.disableHardwareAcceleration();
electronApp.commandLine.appendSwitch("disable-gpu");

electronApp.whenReady().then(async () => {
  try {
    await startLocalServer();
    await createMainWindow();
  } catch (error) {
    if (isSmokeTest) {
      console.error(
        `DESKTOP_SMOKE_FAILED ${error instanceof Error ? error.stack || error.message : String(error)}`
      );
      electronApp.exit(1);
      return;
    }

    dialog.showErrorBox(
      "Video Downloader failed to start",
      error instanceof Error ? error.message : String(error)
    );
    electronApp.quit();
  }
});

electronApp.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

electronApp.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electronApp.quit();
  }
});

electronApp.on("before-quit", () => {
  if (localServer) {
    localServer.close();
    localServer = undefined;
  }
});

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const app = createApp({
      downloadsDir: path.join(electronApp.getPath("userData"), "downloads"),
      finalDownloadsDir: electronApp.getPath("downloads"),
      openFileLocation(filePath) {
        shell.showItemInFolder(filePath);
      }
    });
    const server = app.listen(0, "127.0.0.1", () => {
      localServer = server;
      resolve(server);
    });

    server.on("error", reject);
  });
}

async function createMainWindow() {
  if (!localServer) {
    await startLocalServer();
  }

  const { port } = localServer.address();
  const appUrl = `http://127.0.0.1:${port}`;

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 720,
    minHeight: 620,
    title: "Video Downloader",
    icon: path.join(__dirname, "..", "assets", "app-icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(appUrl)) {
      shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  registerDownloadHandler(mainWindow);

  await mainWindow.loadURL(appUrl);

  if (isSmokeTest) {
    const helperStatus = {
      ffmpeg: hasFfmpeg(),
      whisper: hasWhisper(),
      ytDlp: hasYtDlp()
    };
    const result = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.tool-panel');
        const preview = document.querySelector('.preview-panel');
        const heading = document.querySelector('#page-title');
        const sourceTranscription = document.querySelector('#transcription-source');
        const whisperTranscription = document.querySelector('#transcription-whisper');
        const saveOriginalVideo = document.querySelector('#save-original-video');
        const subtitleLanguageField = document.querySelector('#subtitle-language-field');
        const panelRect = panel ? panel.getBoundingClientRect() : null;
        const previewRect = preview ? preview.getBoundingClientRect() : null;
        const sourceTranscriptionRect = sourceTranscription
          ? sourceTranscription.getBoundingClientRect()
          : null;
        const whisperTranscriptionRect = whisperTranscription
          ? whisperTranscription.getBoundingClientRect()
          : null;
        return {
          title: document.title,
          heading: heading ? heading.textContent : null,
          panelVisible: Boolean(panel && panelRect.width > 0 && panelRect.height > 0),
          previewVisible: Boolean(preview && previewRect.width > 0 && previewRect.height > 0),
          sourceTranscriptionVisible: Boolean(
            sourceTranscription &&
            sourceTranscriptionRect.width > 0 &&
            sourceTranscriptionRect.height > 0
          ),
          whisperTranscriptionVisible: Boolean(
            whisperTranscription &&
            whisperTranscriptionRect.width > 0 &&
            whisperTranscriptionRect.height > 0
          ),
          saveOriginalVideoDefault: Boolean(saveOriginalVideo && saveOriginalVideo.checked),
          subtitleLanguageHidden: Boolean(subtitleLanguageField && subtitleLanguageField.hidden),
          panelRect: panelRect ? {
            width: Math.round(panelRect.width),
            height: Math.round(panelRect.height),
            x: Math.round(panelRect.x),
            y: Math.round(panelRect.y)
          } : null,
          previewRect: previewRect ? {
            width: Math.round(previewRect.width),
            height: Math.round(previewRect.height),
            x: Math.round(previewRect.x),
            y: Math.round(previewRect.y)
          } : null
        };
      })();
    `);

    if (process.env.ELECTRON_CAPTURE_PATH) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const screenshot = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.ELECTRON_CAPTURE_PATH, screenshot.toPNG());
      } catch (error) {
        result.screenshotCaptureError =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (
      !result.panelVisible ||
      !result.previewVisible ||
      !result.sourceTranscriptionVisible ||
      !result.whisperTranscriptionVisible ||
      !result.saveOriginalVideoDefault ||
      !result.subtitleLanguageHidden ||
      !helperStatus.ffmpeg ||
      !helperStatus.whisper ||
      !helperStatus.ytDlp
    ) {
      throw new Error(
        `Desktop smoke test failed: ${JSON.stringify({ ...result, helperStatus })}`
      );
    }

    console.log(
      `DESKTOP_SMOKE_OK ${appUrl} ${JSON.stringify({ ...result, helperStatus })}`
    );
    electronApp.quit();
  }
}

function registerDownloadHandler(window) {
  if (downloadHandlerRegistered) {
    return;
  }

  window.webContents.session.on("will-download", (_event, item) => {
    const savePath = getAvailableDownloadPath(
      electronApp.getPath("downloads"),
      item.getFilename()
    );

    item.setSavePath(savePath);

    item.once("done", (_doneEvent, state) => {
      if (!window || window.isDestroyed()) {
        return;
      }

      if (state === "completed") {
        dispatchDownloadStatus(window, "native-download-complete", {
          fileName: path.basename(savePath),
          filePath: savePath
        });
        return;
      }

      if (state !== "cancelled") {
        dispatchDownloadStatus(window, "native-download-error", {
          message: `The download was ${state} while saving to ${savePath}.`
        });
      }
    });
  });

  downloadHandlerRegistered = true;
}

function dispatchDownloadStatus(window, eventName, detail) {
  const payload = JSON.stringify({ eventName, detail });

  window.webContents
    .executeJavaScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${payload}.detail }));`
    )
    .catch(() => {
      // The page may have navigated or closed after the download started.
    });
}
