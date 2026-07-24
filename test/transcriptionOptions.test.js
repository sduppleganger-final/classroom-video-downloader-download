const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isWhisperTranscription,
  normalizeTranscriptionSelection,
  toSourceSubtitleSelection
} = require("../src/transcriptionOptions");

const video = { downloadType: "video" };
const audio = { downloadType: "audio" };

test("normalizes each explicit transcription mode", () => {
  assert.deepEqual(normalizeTranscriptionSelection({ mode: "none" }, video), {
    ok: true,
    value: { mode: "none", language: "", saveOriginal: false }
  });
  assert.deepEqual(
    normalizeTranscriptionSelection({ mode: "source", language: "iw" }, video),
    {
      ok: true,
      value: { mode: "source", language: "iw", saveOriginal: false }
    }
  );
  assert.deepEqual(
    normalizeTranscriptionSelection(
      { mode: "whisper", saveOriginal: false },
      video
    ),
    {
      ok: true,
      value: { mode: "whisper", language: "auto", saveOriginal: false }
    }
  );
});

test("keeps source transcription request compatibility and rejects transcription for MP3", () => {
  assert.deepEqual(
    normalizeTranscriptionSelection(undefined, video, {
      enabled: true,
      language: "en"
    }).value,
    { mode: "source", language: "en", saveOriginal: false }
  );
  assert.match(
    normalizeTranscriptionSelection({ mode: "whisper" }, audio).message,
    /video downloads only/
  );
});

test("derives backend source and Whisper flags from one normalized choice", () => {
  const source = { mode: "source", language: "fr" };
  const whisper = { mode: "whisper", language: "auto" };

  assert.deepEqual(toSourceSubtitleSelection(source), {
    enabled: true,
    language: "fr"
  });
  assert.equal(isWhisperTranscription(source), false);
  assert.equal(isWhisperTranscription(whisper), true);
});

test("preserves an explicit subtitle review request for video transcription", () => {
  assert.deepEqual(
    normalizeTranscriptionSelection(
      { mode: "source", language: "he", review: true },
      video
    ).value,
    { mode: "source", language: "he", saveOriginal: false, review: true }
  );
  assert.deepEqual(
    normalizeTranscriptionSelection(
      { mode: "whisper", saveOriginal: true, review: true },
      video
    ).value,
    {
      mode: "whisper",
      language: "auto",
      saveOriginal: true,
      review: true
    }
  );
});
