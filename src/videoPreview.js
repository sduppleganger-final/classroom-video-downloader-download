const { spawn } = require("child_process");
const { createFailureDiagnostic } = require("./diagnostics");
const { extractSubtitleLanguages } = require("./sourceSubtitles");
const {
  getYtDlpCommandCandidates,
  getYtDlpCommandParts,
  isYtDlpRuntimeUnavailable
} = require("./ytdlpCommand");

function getVideoPreview(url, resolution, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const previewArgs = buildPreviewArgs(url, resolution);
    const commandCandidates =
      Array.isArray(options.commandCandidates) && options.commandCandidates.length > 0
        ? options.commandCandidates
        : getYtDlpCommandCandidates(previewArgs);
    const startupFailures = [];
    let settled = false;

    startPreviewAttempt(0);

    function startPreviewAttempt(candidateIndex) {
      const commandParts = commandCandidates[candidateIndex] || getYtDlpCommandParts(previewArgs);
      const child = spawn(commandParts.command, commandParts.args, {
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      let startupFailed = false;
      const timeout = setTimeout(() => {
        child.kill();
        const userMessage = "The preview took too long to load.";

        finish(reject, {
          statusCode: 504,
          userMessage,
          diagnosticLog: createFailureDiagnostic({
            operation: "preview",
            userMessage,
            url,
            resolution,
            commandParts,
            stdout,
            stderr,
            startedAtMs,
            extra: addStartupFailuresToExtra(startupFailures, {
              timeoutMs: 45000
            })
          })
        });
      }, 45000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        startupFailed = true;
        clearTimeout(timeout);
        startupFailures.push(describeStartupFailure(commandParts, error));

        if (candidateIndex + 1 < commandCandidates.length) {
          startPreviewAttempt(candidateIndex + 1);
          return;
        }

        const userMessage =
          "The bundled extractor could not start. Reinstall the app package and try again.";

        finish(reject, {
          statusCode: 500,
          userMessage,
          cause: error,
          diagnosticLog: createFailureDiagnostic({
            operation: "preview",
            userMessage,
            url,
            resolution,
            commandParts,
            stdout,
            stderr,
            error,
            startedAtMs,
            extra: addStartupFailuresToExtra(startupFailures)
          })
        });
      });

      child.on("close", (code) => {
        clearTimeout(timeout);

        if (settled || startupFailed) {
          return;
        }

        if (code !== 0) {
          if (
            candidateIndex + 1 < commandCandidates.length &&
            isYtDlpRuntimeUnavailable(stderr || stdout)
          ) {
            startupFailures.push(
              describeProcessFailure(commandParts, code, stderr || stdout)
            );
            startPreviewAttempt(candidateIndex + 1);
            return;
          }

          const userMessage =
            "Could not load a preview for that link. You can still try downloading it.";

          finish(reject, {
            statusCode: 404,
            userMessage,
            diagnosticLog: createFailureDiagnostic({
              operation: "preview",
              userMessage,
              url,
              resolution,
              commandParts,
              stdout,
              stderr,
              exitCode: code,
              startedAtMs,
              extra: addStartupFailuresToExtra(startupFailures)
            })
          });
          return;
        }

        try {
          finish(resolve, parsePreviewOutput(stdout));
        } catch (error) {
          finish(reject, {
            statusCode: 502,
            userMessage:
              error.userMessage || "The preview metadata could not be read.",
            cause: error,
            details: stderr,
            diagnosticLog: createFailureDiagnostic({
              operation: "preview",
              userMessage:
                error.userMessage || "The preview metadata could not be read.",
              url,
              resolution,
              commandParts,
              stdout,
              stderr,
              startedAtMs,
              error,
              extra: addStartupFailuresToExtra(startupFailures)
            })
          });
        }
      });
    }

    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      callback(value);
    }
  });
}

function describeStartupFailure(commandParts, error) {
  return {
    label: commandParts?.label || "unlabeled extractor",
    command: commandParts?.command || "not resolved",
    errorName: error?.name || "not set",
    errorCode: error?.code || "not set",
    errorErrno: typeof error?.errno === "undefined" ? "not set" : error.errno,
    errorSyscall: error?.syscall || "not set",
    errorPath: error?.path || "not set",
    errorMessage: error?.message || String(error)
  };
}

function describeProcessFailure(commandParts, exitCode, output) {
  return {
    label: commandParts?.label || "unlabeled extractor",
    command: commandParts?.command || "not resolved",
    errorName: "ProcessExit",
    errorCode: exitCode,
    errorMessage: String(output || "Extractor exited without output.").slice(-2000)
  };
}

function addStartupFailuresToExtra(startupFailures, extra = {}) {
  if (!startupFailures.length) {
    return extra;
  }

  return {
    ...extra,
    startupFailures
  };
}

function buildPreviewArgs(url, resolution) {
  return [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--dump-single-json",
    "--format",
    resolution.previewFormat,
    url
  ];
}

function parsePreviewOutput(output) {
  const trimmed = output.trim();

  if (!trimmed) {
    throw {
      userMessage: "The extractor did not return preview metadata."
    };
  }

  const payload = JSON.parse(trimmed);
  const streamUrl = findStreamUrl(payload);

  if (!streamUrl) {
    throw {
      userMessage: "The extractor did not return a playable preview stream."
    };
  }

  return {
    title: payload.title || "Video preview",
    duration: typeof payload.duration === "number" ? payload.duration : null,
    thumbnail: payload.thumbnail || "",
    streamUrl,
    webpageUrl: payload.webpage_url || payload.original_url || "",
    subtitleLanguages: extractSubtitleLanguages(payload)
  };
}

function findStreamUrl(payload) {
  if (typeof payload.url === "string" && payload.url) {
    return payload.url;
  }

  if (Array.isArray(payload.requested_downloads)) {
    const requestedDownload = payload.requested_downloads.find((format) => format?.url);

    if (requestedDownload) {
      return requestedDownload.url;
    }
  }

  if (Array.isArray(payload.requested_formats)) {
    const requestedFormat = payload.requested_formats.find((format) => format?.url);

    if (requestedFormat) {
      return requestedFormat.url;
    }
  }

  return "";
}

module.exports = {
  buildPreviewArgs,
  findStreamUrl,
  getVideoPreview,
  parsePreviewOutput
};
