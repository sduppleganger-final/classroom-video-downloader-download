const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getWhisperPaths, getWhisperStatus } = require("../src/whisperPaths");

test("resolves development and packaged Whisper paths", () => {
  assert.deepEqual(
    getWhisperPaths({ projectRoot: "C:\\project", platform: "win32" }),
    {
      command: path.join(
        "C:\\project",
        "vendor",
        "whisper",
        "runtime",
        "Release",
        "whisper-cli.exe"
      ),
      modelPath: path.join(
        "C:\\project",
        "vendor",
        "whisper",
        "models",
        "ggml-small.bin"
      )
    }
  );

  assert.deepEqual(
    getWhisperPaths({
      projectRoot: "C:\\project",
      resourcesPath: "C:\\Electron\\resources",
      platform: "win32",
      isPackaged: false
    }),
    {
      command: path.join(
        "C:\\project",
        "vendor",
        "whisper",
        "runtime",
        "Release",
        "whisper-cli.exe"
      ),
      modelPath: path.join(
        "C:\\project",
        "vendor",
        "whisper",
        "models",
        "ggml-small.bin"
      )
    }
  );
  assert.equal(
    getWhisperPaths({ resourcesPath: "/Applications/App/Resources", platform: "darwin" })
      .command,
    path.join("/Applications/App/Resources", "whisper", "runtime", "whisper-cli")
  );
});

test("reports Whisper available only when runtime launches and model is large enough", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-whisper-paths-"));
  const command = path.join(directory, "whisper-cli.exe");
  const modelPath = path.join(directory, "ggml-small.bin");
  fs.writeFileSync(command, "runtime");
  fs.writeFileSync(modelPath, "model");

  try {
    const status = getWhisperStatus({
      commandParts: { command, args: [], modelPath },
      minimumModelBytes: 1,
      spawnSyncImpl: () => ({ status: 0 })
    });

    assert.equal(status.available, true);
    assert.equal(status.runtimeAvailable, true);
    assert.equal(status.modelAvailable, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
