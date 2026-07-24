import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WHISPER_CPP_VERSION = "v1.9.1";
export const WHISPER_WINDOWS_ARCHIVE_SHA256 =
  "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539";
export const WHISPER_MAC_SOURCE_SHA256 =
  "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447";
export const WHISPER_SMALL_MODEL_SHA256 =
  "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
export const WHISPER_SMALL_MODEL_SIZE = 487601967;
export const WHISPER_VAD_MODEL_SHA256 =
  "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
export const WHISPER_VAD_MODEL_SIZE = 885098;
export const WHISPER_WINDOWS_ARCHIVE_URL =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;
export const WHISPER_MAC_SOURCE_URL =
  `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_CPP_VERSION}.tar.gz`;
export const WHISPER_SMALL_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true";
export const WHISPER_VAD_MODEL_URL =
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin?download=true";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");

export async function prepareWhisper({
  projectRoot = defaultProjectRoot,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  logger = console,
  modelUrl = WHISPER_SMALL_MODEL_URL,
  modelSha256 = WHISPER_SMALL_MODEL_SHA256,
  modelSize = WHISPER_SMALL_MODEL_SIZE,
  vadModelUrl = WHISPER_VAD_MODEL_URL,
  vadModelSha256 = WHISPER_VAD_MODEL_SHA256,
  vadModelSize = WHISPER_VAD_MODEL_SIZE,
  prepareRuntimeImpl = prepareRuntime
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Preparing Whisper requires a Node.js runtime with fetch support.");
  }

  if (platform === "win32" && arch !== "x64") {
    throw new Error(`Whisper packaging does not support Windows ${arch}.`);
  }

  if (platform === "darwin" && !["x64", "arm64"].includes(arch)) {
    throw new Error(`Whisper packaging does not support macOS ${arch}.`);
  }

  if (!["win32", "darwin"].includes(platform)) {
    throw new Error(`Whisper packaging is not configured for ${platform}.`);
  }

  const whisperRoot = path.join(projectRoot, "vendor", "whisper");
  const modelPath = path.join(whisperRoot, "models", "ggml-small.bin");
  const vadModelPath = path.join(
    whisperRoot,
    "models",
    "ggml-silero-v6.2.0.bin"
  );

  await mkdir(path.dirname(modelPath), { recursive: true });
  await ensureVerifiedFile({
    targetPath: modelPath,
    url: modelUrl,
    expectedSha256: modelSha256,
    expectedSize: modelSize,
    fetchImpl,
    logger,
    label: "Whisper Small multilingual model"
  });
  await ensureVerifiedFile({
    targetPath: vadModelPath,
    url: vadModelUrl,
    expectedSha256: vadModelSha256,
    expectedSize: vadModelSize,
    fetchImpl,
    logger,
    label: "Silero voice activity model"
  });

  const runtimePath = await prepareRuntimeImpl({
    whisperRoot,
    platform,
    arch,
    fetchImpl,
    logger
  });

  logger.log(`Whisper model: ${modelPath}`);
  logger.log(`Whisper VAD model: ${vadModelPath}`);
  logger.log(`Whisper runtime: ${runtimePath}`);

  return { modelPath, vadModelPath, runtimePath };
}

export async function ensureVerifiedFile({
  targetPath,
  url,
  expectedSha256,
  expectedSize,
  fetchImpl = globalThis.fetch,
  logger = console,
  label = "file"
}) {
  const existing = await describeFile(targetPath);

  if (
    existing &&
    (!expectedSize || existing.size === expectedSize) &&
    (await hashFile(targetPath)) === expectedSha256
  ) {
    logger.log(`${label} is already present and verified.`);
    return targetPath;
  }

  logger.log(`Downloading ${label}...`);
  const response = await fetchImpl(url, {
    headers: buildDownloadHeaders(url),
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Could not download ${label} (HTTP ${response.status}).`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.download`;
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      callback(null, chunk);
    }
  });
  const responseStream = response.body
    ? Readable.fromWeb(response.body)
    : Readable.from(Buffer.from(await response.arrayBuffer()));

  try {
    await pipeline(responseStream, hashingStream, createWriteStream(temporaryPath));
    const downloadedHash = hash.digest("hex");

    if (expectedSize && downloadedBytes !== expectedSize) {
      throw new Error(
        `${label} size mismatch: expected ${expectedSize}, received ${downloadedBytes}.`
      );
    }

    if (downloadedHash !== expectedSha256) {
      throw new Error(
        `${label} checksum mismatch: expected ${expectedSha256}, received ${downloadedHash}.`
      );
    }

    await rename(temporaryPath, targetPath);
    logger.log(`Prepared ${label} (${downloadedBytes} bytes).`);
    logger.log(`SHA-256: ${downloadedHash}`);
    return targetPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function prepareRuntime({ whisperRoot, platform, arch, fetchImpl, logger }) {
  const runtimeDir = path.join(whisperRoot, "runtime");
  const metadataPath = path.join(runtimeDir, "runtime.json");
  const executablePath = path.join(
    runtimeDir,
    ...(platform === "win32"
      ? ["Release", "whisper-cli.exe"]
      : ["whisper-cli"])
  );
  const metadata = await readJson(metadataPath);

  if (
    metadata?.version === WHISPER_CPP_VERSION &&
    metadata?.platform === platform &&
    metadata?.arch === arch &&
    (await describeFile(executablePath))
  ) {
    if (platform === "darwin") {
      await chmod(executablePath, 0o755);
    }
    logger.log(`Whisper ${WHISPER_CPP_VERSION} runtime is already prepared.`);
    return executablePath;
  }

  await mkdir(runtimeDir, { recursive: true });

  if (platform === "win32") {
    await prepareWindowsRuntime({ whisperRoot, runtimeDir, fetchImpl, logger });
  } else {
    await prepareMacRuntime({ whisperRoot, runtimeDir, arch, fetchImpl, logger });
  }

  await writeFile(
    metadataPath,
    `${JSON.stringify({ version: WHISPER_CPP_VERSION, platform, arch }, null, 2)}\n`,
    "utf8"
  );

  return executablePath;
}

async function prepareWindowsRuntime({ whisperRoot, runtimeDir, fetchImpl, logger }) {
  const archivePath = path.join(
    whisperRoot,
    "cache",
    `whisper-bin-x64-${WHISPER_CPP_VERSION}.zip`
  );

  await ensureVerifiedFile({
    targetPath: archivePath,
    url: WHISPER_WINDOWS_ARCHIVE_URL,
    expectedSha256: WHISPER_WINDOWS_ARCHIVE_SHA256,
    fetchImpl,
    logger,
    label: `whisper.cpp ${WHISPER_CPP_VERSION} Windows runtime`
  });
  runCommand("tar", ["-xf", archivePath, "-C", runtimeDir], {
    label: "extracting the Windows Whisper runtime"
  });
}

async function prepareMacRuntime({ whisperRoot, runtimeDir, arch, fetchImpl, logger }) {
  const cacheDir = path.join(whisperRoot, "cache");
  const archivePath = path.join(cacheDir, `whisper.cpp-${WHISPER_CPP_VERSION}.tar.gz`);
  const sourceDir = path.join(
    cacheDir,
    `whisper.cpp-${WHISPER_CPP_VERSION.replace(/^v/, "")}`
  );
  const buildDir = path.join(cacheDir, `build-macos-${arch}`);

  await ensureVerifiedFile({
    targetPath: archivePath,
    url: WHISPER_MAC_SOURCE_URL,
    expectedSha256: WHISPER_MAC_SOURCE_SHA256,
    fetchImpl,
    logger,
    label: `whisper.cpp ${WHISPER_CPP_VERSION} source`
  });

  if (!(await describeFile(path.join(sourceDir, "CMakeLists.txt")))) {
    await mkdir(cacheDir, { recursive: true });
    runCommand("tar", ["-xzf", archivePath, "-C", cacheDir], {
      label: "extracting the macOS Whisper source"
    });
  }

  const cmakeArgs = [
    "-S",
    sourceDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${arch === "arm64" ? "arm64" : "x86_64"}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DGGML_ACCELERATE=ON",
    `-DGGML_METAL=${arch === "arm64" ? "ON" : "OFF"}`
  ];

  runCommand("cmake", cmakeArgs, { label: "configuring the macOS Whisper runtime" });
  runCommand(
    "cmake",
    ["--build", buildDir, "--config", "Release", "--target", "whisper-cli", "-j", "3"],
    { label: "building the macOS Whisper runtime" }
  );

  const builtPath = await firstExistingFile([
    path.join(buildDir, "bin", "whisper-cli"),
    path.join(buildDir, "bin", "Release", "whisper-cli")
  ]);

  if (!builtPath) {
    throw new Error("The macOS Whisper build completed without producing whisper-cli.");
  }

  const targetPath = path.join(runtimeDir, "whisper-cli");
  await copyFile(builtPath, targetPath);
  await chmod(targetPath, 0o755);
}

function runCommand(command, args, { label }) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
}

function buildDownloadHeaders(url) {
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "classroom-video-downloader-build"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (token && /^https:\/\/github\.com\//i.test(url)) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function describeFile(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() && stats.size > 0 ? stats : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function firstExistingFile(paths) {
  for (const filePath of paths) {
    if (await describeFile(filePath)) {
      return filePath;
    }
  }
  return "";
}

async function hashFile(filePath) {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  const requestedArch = process.argv
    .find((argument) => argument.startsWith("--arch="))
    ?.slice("--arch=".length);

  try {
    await prepareWhisper({ arch: requestedArch || process.arch });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
