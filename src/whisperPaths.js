const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const minimumModelBytes = 400 * 1024 * 1024;

function getWhisperPaths(options = {}) {
  const platform = options.platform || process.platform;
  const resourcesPath = options.resourcesPath || process.resourcesPath || "";
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..");
  const isPackaged =
    typeof options.isPackaged === "boolean"
      ? options.isPackaged
      : Object.prototype.hasOwnProperty.call(options, "resourcesPath")
        ? Boolean(options.resourcesPath)
        : __dirname.includes("app.asar") ||
          Boolean(resourcesPath && fs.existsSync(path.join(resourcesPath, "app.asar")));
  const whisperRoot = isPackaged
    ? path.join(resourcesPath, "whisper")
    : path.join(projectRoot, "vendor", "whisper");
  const defaultCommand = path.join(
    whisperRoot,
    "runtime",
    ...(platform === "win32" ? ["Release", "whisper-cli.exe"] : ["whisper-cli"])
  );

  return {
    command: process.env.WHISPER_CLI_PATH || defaultCommand,
    modelPath:
      process.env.WHISPER_MODEL_PATH ||
      path.join(whisperRoot, "models", "ggml-small.bin")
  };
}

function getWhisperCommandParts(options = {}) {
  const paths = getWhisperPaths(options);

  return {
    command: paths.command,
    args: [],
    modelPath: paths.modelPath,
    label: "bundled whisper.cpp Small runtime"
  };
}

function getWhisperStatus(options = {}) {
  const commandParts = options.commandParts || getWhisperCommandParts(options);
  const modelMinimumBytes = options.minimumModelBytes ?? minimumModelBytes;
  const command = describeFile(commandParts.command);
  const model = describeFile(commandParts.modelPath);
  let runtimeAvailable = false;

  if (command.exists) {
    const result = (options.spawnSyncImpl || spawnSync)(
      commandParts.command,
      [...(commandParts.args || []), "--version"],
      { stdio: "ignore", windowsHide: true }
    );
    runtimeAvailable = !result.error && result.status === 0;
  }

  return {
    available:
      runtimeAvailable && model.exists && model.size >= modelMinimumBytes,
    runtimeAvailable,
    modelAvailable: model.exists && model.size >= modelMinimumBytes,
    commandPath: commandParts.command,
    modelPath: commandParts.modelPath,
    modelSize: model.size
  };
}

function hasWhisper(options = {}) {
  return getWhisperStatus(options).available;
}

function describeFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: stats.isFile() && stats.size > 0,
      size: stats.isFile() ? stats.size : 0
    };
  } catch {
    return { exists: false, size: 0 };
  }
}

module.exports = {
  getWhisperCommandParts,
  getWhisperPaths,
  getWhisperStatus,
  hasWhisper,
  minimumModelBytes
};
