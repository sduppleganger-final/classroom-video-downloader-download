const { normalizeSourceSubtitleSelection } = require("./sourceSubtitles");

const transcriptionModes = Object.freeze({
  none: "none",
  source: "source",
  whisper: "whisper"
});

function normalizeTranscriptionSelection(value, resolution, legacySourceSelection) {
  const legacyEnabled = legacySourceSelection?.enabled === true;
  const requestedMode = legacyEnabled
    ? transcriptionModes.source
    : typeof value?.mode === "string"
      ? value.mode.trim().toLowerCase()
      : transcriptionModes.none;

  if (!Object.values(transcriptionModes).includes(requestedMode)) {
    return {
      ok: false,
      message: "Choose no transcription, source transcription, or Whisper transcription."
    };
  }

  if (requestedMode === transcriptionModes.source) {
    const source = normalizeSourceSubtitleSelection(
      {
        enabled: true,
        language: legacyEnabled ? legacySourceSelection.language : value?.language
      },
      resolution
    );

    if (!source.ok) {
      return source;
    }

    return {
      ok: true,
      value: {
        mode: transcriptionModes.source,
        language: source.value.language,
        saveOriginal: false,
        ...(value?.review === true ? { review: true } : {})
      }
    };
  }

  if (requestedMode === transcriptionModes.whisper) {
    if (resolution?.downloadType === "audio") {
      return {
        ok: false,
        message: "Whisper transcription is available for video downloads only."
      };
    }

    return {
      ok: true,
      value: {
        mode: transcriptionModes.whisper,
        language: "auto",
        saveOriginal: value?.saveOriginal !== false,
        ...(value?.review === true ? { review: true } : {})
      }
    };
  }

  return {
    ok: true,
    value: {
      mode: transcriptionModes.none,
      language: "",
      saveOriginal: false
    }
  };
}

function toSourceSubtitleSelection(transcription) {
  return transcription?.mode === transcriptionModes.source
    ? { enabled: true, language: transcription.language }
    : { enabled: false, language: "" };
}

function isWhisperTranscription(transcription) {
  return transcription?.mode === transcriptionModes.whisper;
}

module.exports = {
  isWhisperTranscription,
  normalizeTranscriptionSelection,
  toSourceSubtitleSelection,
  transcriptionModes
};
