import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const builder = path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
const requestedArch = parseArch(process.argv.slice(2));
const buildRoot = process.env.CLASSROOM_VIDEO_MAC_BUILD_ROOT
  ? path.resolve(process.env.CLASSROOM_VIDEO_MAC_BUILD_ROOT)
  : path.join(projectRoot, "dist-mac");

if (process.platform !== "darwin") {
  console.error("Mac packaging must be run on macOS.");
  console.error("Electron Builder does not create macOS app bundles from Windows or Linux.");
  console.error("Use the GitHub Actions workflow or run this command on a Mac:");
  console.error(`  npm run build:mac -- --arch=${requestedArch}`);
  process.exit(1);
}

if (!existsSync(builder)) {
  console.error("electron-builder was not found. Run npm install first.");
  process.exit(1);
}

mkdirSync(buildRoot, { recursive: true });

const args = [
  builder,
  "--mac",
  "zip",
  `--${requestedArch}`,
  `--config.directories.output=${buildRoot}`,
  "--publish",
  "never"
];

console.log(`Building macOS ${requestedArch} package into ${buildRoot}`);

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false"
  },
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

printArtifacts(buildRoot, requestedArch);

function parseArch(args) {
  const valueArg = args.find((arg) => arg.startsWith("--arch="));

  if (valueArg) {
    return normalizeArch(valueArg.slice("--arch=".length));
  }

  if (args.includes("--x64")) {
    return "x64";
  }

  if (args.includes("--arm64")) {
    return "arm64";
  }

  if (process.env.npm_config_arch) {
    return normalizeArch(process.env.npm_config_arch);
  }

  return normalizeArch(process.arch);
}

function normalizeArch(value) {
  if (value === "x64" || value === "arm64") {
    return value;
  }

  console.error(`Unsupported Mac architecture: ${value}`);
  console.error("Use --arch=x64 for Intel Macs or --arch=arm64 for Apple Silicon Macs.");
  process.exit(1);
}

function printArtifacts(outputDir, arch) {
  const artifacts = readdirSync(outputDir)
    .filter((name) => name.endsWith(".zip") && name.includes(`mac-${arch}`))
    .map((name) => path.join(outputDir, name));

  for (const artifact of artifacts) {
    const stats = statSync(artifact);
    console.log(`Mac package: ${artifact}`);
    console.log(`Size: ${stats.size} bytes`);
  }
}
