const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("prepareWhisper installs a verified model and delegated native runtime", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "cvd-whisper-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const module = await import("../scripts/prepare-whisper.mjs");
  const model = Buffer.from("test multilingual model");
  const modelSha256 = createHash("sha256").update(model).digest("hex");
  const vadModel = Buffer.from("test voice activity model");
  const vadModelSha256 = createHash("sha256").update(vadModel).digest("hex");
  let runtimeRequest = null;

  const result = await module.prepareWhisper({
    projectRoot,
    platform: "win32",
    arch: "x64",
    modelUrl: "https://example.test/ggml-small.bin",
    modelSha256,
    modelSize: model.length,
    vadModelUrl: "https://example.test/ggml-silero.bin",
    vadModelSha256,
    vadModelSize: vadModel.length,
    logger: { log() {} },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        url.includes("silero") ? vadModel : model
    }),
    prepareRuntimeImpl: async (request) => {
      runtimeRequest = request;
      const runtimePath = path.join(request.whisperRoot, "runtime", "whisper-cli.exe");
      await mkdir(path.dirname(runtimePath), { recursive: true });
      await writeFile(runtimePath, "runtime");
      return runtimePath;
    }
  });

  assert.equal(runtimeRequest.platform, "win32");
  assert.equal(runtimeRequest.arch, "x64");
  assert.deepEqual(await readFile(result.modelPath), model);
  assert.deepEqual(await readFile(result.vadModelPath), vadModel);
  assert.match(result.runtimePath, /whisper-cli\.exe$/);
});

test("ensureVerifiedFile rejects a model with the wrong checksum", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvd-whisper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = await import("../scripts/prepare-whisper.mjs");

  await assert.rejects(
    module.ensureVerifiedFile({
      targetPath: path.join(directory, "model.bin"),
      url: "https://example.test/model.bin",
      expectedSha256: createHash("sha256").update("expected").digest("hex"),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("unexpected")
      }),
      logger: { log() {} }
    }),
    /checksum mismatch/
  );
});

test("prepareWhisper rejects platforms without a packaged runtime", async () => {
  const module = await import("../scripts/prepare-whisper.mjs");

  await assert.rejects(
    module.prepareWhisper({ platform: "linux", arch: "x64" }),
    /not configured/
  );
});
