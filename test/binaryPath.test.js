const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvePackagedBinaryPath } = require("../src/binaryPath");

test("prefers an unpacked executable when the ASAR virtual path also exists", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-asar-path-"));
  const virtualPath = path.join(fixtureRoot, "resources", "app.asar", "bin", "yt-dlp.exe");
  const unpackedPath = path.join(
    fixtureRoot,
    "resources",
    "app.asar.unpacked",
    "bin",
    "yt-dlp.exe"
  );

  try {
    fs.mkdirSync(path.dirname(virtualPath), { recursive: true });
    fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
    fs.writeFileSync(virtualPath, "virtual ASAR entry");
    fs.writeFileSync(unpackedPath, "real executable");

    assert.equal(resolvePackagedBinaryPath(virtualPath), unpackedPath);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("keeps an ordinary executable path unchanged", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-binary-path-"));
  const executablePath = path.join(fixtureRoot, "yt-dlp.exe");

  try {
    fs.writeFileSync(executablePath, "executable");
    assert.equal(resolvePackagedBinaryPath(executablePath), executablePath);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
