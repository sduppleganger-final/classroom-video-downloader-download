const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getYtDlpCommandCandidates,
  isYtDlpRuntimeUnavailable
} = require("../src/ytdlpCommand");

test("prefers the native static extractor on macOS", () => {
  const candidates = getYtDlpCommandCandidates(["--version"], {
    platform: "darwin"
  });

  assert.equal(candidates[0].label, "bundled yt-dlp-static");
  assert.match(candidates[0].command, /yt-dlp-static/);
});

test("recognizes unavailable extractor runtimes without retrying ordinary media errors", () => {
  assert.equal(
    isYtDlpRuntimeUnavailable(
      "ImportError: You are using an unsupported version of Python. Only Python versions 3.10 and above are supported by yt-dlp"
    ),
    true
  );
  assert.equal(
    isYtDlpRuntimeUnavailable("ERROR: Video unavailable"),
    false
  );
});
