const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("prepareMacYtDlp installs a checksum-verified native executable", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "cvd-mac-ytdlp-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const module = await import("../scripts/prepare-mac-ytdlp.mjs");
  const binary = Buffer.from("test native mac extractor");
  const expectedSha256 = module.sha256(binary);
  let requestedUrl = null;

  const targetPath = await module.prepareMacYtDlp({
    projectRoot,
    platform: "darwin",
    version: "test-version",
    downloadUrl: "https://example.test/yt-dlp_macos",
    expectedSha256,
    logger: { log() {} },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => binary
      };
    }
  });

  assert.equal(requestedUrl, "https://example.test/yt-dlp_macos");
  assert.equal(
    targetPath,
    path.join(projectRoot, "node_modules", "yt-dlp-static", "bin", "mac", "yt-dlp")
  );
  assert.deepEqual(await readFile(targetPath), binary);
});

test("prepareMacYtDlp rejects an unverified download", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "cvd-mac-ytdlp-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const module = await import("../scripts/prepare-mac-ytdlp.mjs");

  await assert.rejects(
    module.prepareMacYtDlp({
      projectRoot,
      platform: "darwin",
      expectedSha256: module.sha256(Buffer.from("expected")),
      logger: { log() {} },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("unexpected")
      })
    }),
    /checksum mismatch/
  );
});
