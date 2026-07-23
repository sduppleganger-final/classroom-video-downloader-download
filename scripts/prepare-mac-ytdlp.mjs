import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const YT_DLP_MAC_VERSION = "2026.07.04";
export const YT_DLP_MAC_SHA256 = "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b";
export const YT_DLP_MAC_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_MAC_VERSION}/yt-dlp_macos`;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");

export async function prepareMacYtDlp({
  projectRoot = defaultProjectRoot,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  logger = console,
  version = YT_DLP_MAC_VERSION,
  downloadUrl = YT_DLP_MAC_URL,
  expectedSha256 = YT_DLP_MAC_SHA256
} = {}) {
  if (platform !== "darwin") {
    throw new Error("The native Mac extractor can only be prepared on macOS.");
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("This build requires a Node.js runtime with fetch support.");
  }

  const targetPath = path.join(projectRoot, "node_modules", "yt-dlp-static", "bin", "mac", "yt-dlp");
  const currentHash = await hashFile(targetPath);

  if (currentHash === expectedSha256) {
    await chmod(targetPath, 0o755);
    logger.log(`Native Mac extractor ${version} is already current.`);
    return targetPath;
  }

  logger.log(`Downloading native Mac extractor ${version}...`);
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "classroom-video-downloader-build"
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(downloadUrl, { headers, redirect: "follow" });

  if (!response.ok) {
    throw new Error(`Could not download the native Mac extractor (HTTP ${response.status}).`);
  }

  const binary = Buffer.from(await response.arrayBuffer());
  const downloadedHash = sha256(binary);

  if (downloadedHash !== expectedSha256) {
    throw new Error(
      `Native Mac extractor checksum mismatch: expected ${expectedSha256}, received ${downloadedHash}.`
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.download`;

  try {
    await writeFile(temporaryPath, binary, { mode: 0o755 });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  logger.log(`Prepared ${targetPath}`);
  logger.log(`SHA-256: ${downloadedHash}`);
  return targetPath;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  try {
    return sha256(await readFile(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  try {
    await prepareMacYtDlp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
