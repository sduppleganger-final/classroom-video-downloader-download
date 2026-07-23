const { spawnSync } = require("child_process");
const { getPythonCommand } = require("./pythonCommand");
const { resolvePackagedBinaryPath } = require("./binaryPath");

function getYtDlpCommandParts(args) {
  const [candidate] = getYtDlpCommandCandidates(args);

  if (candidate) {
    return candidate;
  }

  return {
    command: getPythonCommand(),
    args: ["-m", "yt_dlp", ...args]
  };
}

function getYtDlpCommandCandidates(args, options = {}) {
  const explicitPath = process.env.YT_DLP_PATH || process.env.YTDLP_BIN || "";

  if (explicitPath.trim()) {
    return [
      {
        command: resolvePackagedBinaryPath(explicitPath),
        args,
        label: "configured yt-dlp executable"
      }
    ];
  }

  const candidates = [];

  if ((options.platform || process.platform) === "darwin") {
    addExecutableCandidate(candidates, getYtDlpStaticPath(), args, "bundled yt-dlp-static");
  }

  addExecutableCandidate(candidates, getYoutubeDlExecPath(), args, "bundled youtube-dl-exec yt-dlp");
  addExecutableCandidate(candidates, getYtDlpStaticPath(), args, "bundled yt-dlp-static");

  candidates.push({
    command: getPythonCommand(),
    args: ["-m", "yt_dlp", ...args],
    label: "Python yt_dlp module"
  });

  return dedupeCandidates(candidates);
}

function getYtDlpExecutablePath() {
  const [candidate] = getYtDlpCommandCandidates([]);

  return candidate?.command || "";
}

function getBundledYtDlpPath() {
  if (process.platform === "darwin") {
    const nativeMacPath = getYtDlpStaticPath();

    if (nativeMacPath) {
      return nativeMacPath;
    }
  }

  const youtubeDlExecPath = getYoutubeDlExecPath();

  if (youtubeDlExecPath) {
    return youtubeDlExecPath;
  }

  return getYtDlpStaticPath();
}

function getYoutubeDlExecPath() {
  try {
    const { constants } = require("youtube-dl-exec");

    return resolvePackagedBinaryPath(constants.YOUTUBE_DL_PATH || "");
  } catch {
    return "";
  }
}

function getYtDlpStaticPath() {
  if (!["win32", "darwin"].includes(process.platform)) {
    return "";
  }

  try {
    return resolvePackagedBinaryPath(require("yt-dlp-static") || "");
  } catch {
    return "";
  }
}

function hasYtDlp() {
  for (const { command, args } of getYtDlpCommandCandidates(["--version"])) {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      windowsHide: true
    });

    if (!result.error && result.status === 0) {
      return true;
    }
  }

  return false;
}

function isYtDlpRuntimeUnavailable(output) {
  const normalized = String(output || "").toLowerCase();

  return [
    "unsupported version of python",
    "env: python3: no such file or directory",
    "python3: command not found",
    "modulenotfounderror: no module named 'yt_dlp'",
    "bad cpu type in executable",
    "cannot execute binary file",
    "exec format error"
  ].some((pattern) => normalized.includes(pattern));
}

function addExecutableCandidate(candidates, executablePath, args, label) {
  if (!executablePath) {
    return;
  }

  candidates.push({
    command: executablePath,
    args,
    label
  });
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const key = `${candidate.command}\0${candidate.args.join("\0")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

module.exports = {
  getBundledYtDlpPath,
  getYtDlpCommandCandidates,
  getYtDlpCommandParts,
  getYtDlpExecutablePath,
  hasYtDlp,
  isYtDlpRuntimeUnavailable
};
