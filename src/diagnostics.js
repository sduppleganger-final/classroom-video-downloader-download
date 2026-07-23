const fs = require("fs");
const path = require("path");

const maxOutputChars = 6000;

function createFailureDiagnostic({
  operation,
  userMessage,
  url,
  resolution,
  downloadsDir,
  commandParts,
  stdout,
  stderr,
  exitCode,
  error,
  startedAtMs,
  endedAtMs = Date.now(),
  extra
}) {
  const lines = [
    "Classroom Video Downloader diagnostic log",
    `Created: ${new Date(endedAtMs).toISOString()}`,
    "",
    "[Summary]",
    `Operation: ${operation || "unknown"}`,
    `User-facing error: ${userMessage || "Unknown error"}`,
    `Duration: ${formatDuration(startedAtMs, endedAtMs)}`,
    ""
  ];

  lines.push("[Environment]");
  lines.push(`App version: ${readPackageVersion()}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Node: ${process.version}`);
  lines.push(`Electron: ${process.versions.electron || "not running under Electron"}`);
  lines.push(`Packaged app: ${Boolean(process.resourcesPath && process.resourcesPath.includes("resources"))}`);
  lines.push(`Current working directory: ${process.cwd()}`);
  lines.push(`App directory: ${path.resolve(__dirname, "..")}`);
  lines.push(`Resources path: ${process.resourcesPath || "not set"}`);
  lines.push(`Downloads directory: ${downloadsDir ? path.resolve(downloadsDir) : "not set"}`);
  lines.push("");

  if (url || resolution) {
    lines.push("[Request]");
    lines.push(`URL: ${url || "not provided"}`);
    lines.push(`Resolution label: ${resolution?.label || "not provided"}`);
    lines.push(`Resolution value: ${resolution?.value || "not provided"}`);
    lines.push(`Download type: ${resolution?.downloadType || "not provided"}`);
    lines.push(`Format selector: ${resolution?.format || resolution?.previewFormat || "not provided"}`);
    lines.push("");
  }

  if (commandParts) {
    lines.push("[Extractor command]");
    lines.push(`Command: ${commandParts.command || "not resolved"}`);
    lines.push(`Arguments: ${formatArgs(commandParts.args)}`);
    lines.push(...describePath(commandParts.command, "Command path"));
    lines.push("");
  }

  if (typeof exitCode !== "undefined" || error) {
    lines.push("[Process result]");
    if (typeof exitCode !== "undefined") {
      lines.push(`Exit code: ${exitCode}`);
    }

    if (error) {
      lines.push(`Spawn error name: ${error.name || "not set"}`);
      lines.push(`Spawn error code: ${error.code || "not set"}`);
      lines.push(`Spawn error errno: ${typeof error.errno === "undefined" ? "not set" : error.errno}`);
      lines.push(`Spawn error syscall: ${error.syscall || "not set"}`);
      lines.push(`Spawn error path: ${error.path || "not set"}`);
      lines.push(`Spawn error message: ${error.message || String(error)}`);
    }
    lines.push("");
  }

  if (extra && typeof extra === "object") {
    lines.push("[Extra]");
    for (const [key, value] of Object.entries(extra)) {
      lines.push(`${key}: ${formatValue(value)}`);
    }
    lines.push("");
  }

  if (stdout) {
    lines.push("[Extractor stdout tail]");
    lines.push(trimOutput(stdout));
    lines.push("");
  }

  if (stderr) {
    lines.push("[Extractor stderr tail]");
    lines.push(trimOutput(stderr));
    lines.push("");
  }

  lines.push("[Next steps]");
  lines.push("1. Send this log to the instructor or app maintainer.");
  lines.push("2. If the command path is missing or access is denied, security software may have blocked the bundled extractor.");
  lines.push("3. Re-download the latest portable app from the official class download page.");

  return lines.join("\n");
}

function toErrorPayload(error, fallbackMessage) {
  const payload = {
    error: error?.userMessage || fallbackMessage
  };

  if (error?.diagnosticLog) {
    payload.diagnosticLog = error.diagnosticLog;
    payload.diagnosticFileName = buildDiagnosticFileName();
  }

  return payload;
}

function buildDiagnosticFileName(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "-");

  return `classroom-video-downloader-log-${stamp}.txt`;
}

function describePath(filePath, label) {
  const lines = [];

  if (!filePath) {
    lines.push(`${label}: not set`);
    return lines;
  }

  const resolvedPath = path.resolve(filePath);
  lines.push(`${label} resolved: ${resolvedPath}`);

  try {
    const stats = fs.statSync(resolvedPath);
    lines.push(`${label} exists: true`);
    lines.push(`${label} is file: ${stats.isFile()}`);
    lines.push(`${label} size: ${stats.size}`);
    lines.push(`${label} modified: ${stats.mtime.toISOString()}`);
  } catch (error) {
    lines.push(`${label} exists: false`);
    lines.push(`${label} stat error: ${error.code || error.message}`);
  }

  return lines;
}

function formatArgs(args = []) {
  if (!Array.isArray(args) || args.length === 0) {
    return "none";
  }

  return args.map((arg) => JSON.stringify(String(arg))).join(" ");
}

function trimOutput(value) {
  const text = String(value).trim();

  if (text.length <= maxOutputChars) {
    return text;
  }

  return `[trimmed to last ${maxOutputChars} characters]\n${text.slice(-maxOutputChars)}`;
}

function formatDuration(startedAtMs, endedAtMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return "unknown";
  }

  return `${Math.max(0, endedAtMs - startedAtMs)} ms`;
}

function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );

    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}

module.exports = {
  buildDiagnosticFileName,
  createFailureDiagnostic,
  toErrorPayload
};
