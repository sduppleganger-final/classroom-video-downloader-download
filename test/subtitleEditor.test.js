const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyCueEdits,
  finalizeSubtitleReview,
  formatSrtCues,
  getSubtitleRenderStyle,
  normalizeSubtitleReviewJobData,
  normalizeSubtitleStyle,
  parseSrtCues
} = require("../src/subtitleEditor");

const sampleSrt = [
  "1",
  "00:00:00,250 --> 00:00:02,500",
  "Hello &amp; welcome",
  "",
  "2",
  "00:00:03,000 --> 00:00:05,125",
  "Second line",
  ""
].join("\n");

test("parses editable SRT cues while preserving immutable timestamps", () => {
  const cues = parseSrtCues(sampleSrt);

  assert.deepEqual(cues, [
    { id: "1", startMs: 250, endMs: 2500, text: "Hello & welcome" },
    { id: "2", startMs: 3000, endMs: 5125, text: "Second line" }
  ]);

  const edited = applyCueEdits(cues, [
    { id: "1", text: "Corrected opening" },
    { id: "2", text: "Corrected ending" }
  ]);

  assert.deepEqual(
    edited.map(({ startMs, endMs }) => ({ startMs, endMs })),
    [
      { startMs: 250, endMs: 2500 },
      { startMs: 3000, endMs: 5125 }
    ]
  );
  assert.match(formatSrtCues(edited), /00:00:00,250 --> 00:00:02,500/);
  assert.match(formatSrtCues(edited), /Corrected opening/);
});

test("rejects incomplete, duplicate, unknown, and oversized cue edits", () => {
  const cues = parseSrtCues(sampleSrt);

  assert.throws(
    () => applyCueEdits(cues, [{ id: "1", text: "Only one" }]),
    /Every subtitle cue/
  );
  assert.throws(
    () =>
      applyCueEdits(cues, [
        { id: "1", text: "One" },
        { id: "1", text: "Duplicate" }
      ]),
    /does not match/
  );
  assert.throws(
    () =>
      applyCueEdits(cues, [
        { id: "1", text: "One" },
        { id: "unexpected", text: "Unknown" }
      ]),
    /does not match/
  );
  assert.throws(
    () =>
      applyCueEdits(cues, [
        { id: "1", text: "x".repeat(4001) },
        { id: "2", text: "Two" }
      ]),
    /longer than 4000/
  );
});

test("normalizes the nine-position style and converts RGB colors for libass", () => {
  assert.deepEqual(normalizeSubtitleStyle({
    position: "top-right",
    fontSize: 31.6,
    color: "#12aBcD"
  }), {
    position: "top-right",
    fontSize: 32,
    color: "#12ABCD"
  });
  assert.deepEqual(getSubtitleRenderStyle({
    position: "middle-left",
    fontSize: 20,
    color: "#112233"
  }), {
    position: "middle-left",
    fontSize: 20,
    color: "#112233",
    alignment: 9,
    primaryColour: "&H00332211",
    marginV: 0,
    marginL: 32,
    marginR: 32
  });
});

test("finalizes corrected SRT and TXT files with the selected render style", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-subtitle-editor-"));
  const mediaPath = path.join(directory, "lecture.mp4");
  const subtitlePath = path.join(directory, "lecture.en.srt");
  const transcriptPath = path.join(directory, "lecture.en.txt");
  const outputPath = path.join(directory, "lecture-captioned.mp4");
  let renderOptions;

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(mediaPath, "video");
  fs.writeFileSync(subtitlePath, sampleSrt);
  fs.writeFileSync(transcriptPath, "old transcript");

  const review = normalizeSubtitleReviewJobData({
    mode: "source",
    mediaPath,
    subtitlePath,
    transcriptPath,
    outputPath,
    language: "en",
    languageName: "English",
    artifacts: [],
    cleanupFilePaths: []
  }, directory);
  const result = await finalizeSubtitleReview({
    review,
    cueEdits: [
      { id: "1", text: "Corrected <opening> & welcome" },
      { id: "2", text: "Corrected ending" }
    ],
    style: { position: "top-right", fontSize: 30, color: "#33CC66" },
    renderImpl: async (options) => {
      renderOptions = options;
      fs.writeFileSync(options.outputPath, "captioned");
    }
  });

  assert.deepEqual(renderOptions.captionStyle, {
    position: "top-right",
    fontSize: 30,
    color: "#33CC66"
  });
  assert.match(fs.readFileSync(subtitlePath, "utf8"), /Corrected &lt;opening&gt; &amp; welcome/);
  assert.equal(
    fs.readFileSync(transcriptPath, "utf8"),
    "Corrected <opening> & welcome\n\nCorrected ending\n"
  );
  assert.equal(result.fileName, "lecture-captioned.mp4");
  assert.deepEqual(result.finalizedStyle, renderOptions.captionStyle);
});

test("rejects review paths that escape the download workspace", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-review-root-"));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-review-outside-"));
  const mediaPath = path.join(outsideDirectory, "outside.mp4");
  const subtitlePath = path.join(directory, "inside.srt");
  const transcriptPath = path.join(directory, "inside.txt");

  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  });
  fs.writeFileSync(mediaPath, "video");
  fs.writeFileSync(subtitlePath, sampleSrt);
  fs.writeFileSync(transcriptPath, "transcript");

  assert.equal(normalizeSubtitleReviewJobData({
    mediaPath,
    subtitlePath,
    transcriptPath,
    outputPath: path.join(directory, "output.mp4")
  }, directory), null);
});
