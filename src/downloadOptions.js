const formatWithAudioAndVideo =
  "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best[ext=mp4]/best";
const previewFormat =
  "best[ext=mp4][vcodec!=none]/best[vcodec!=none]/best[ext=mp4]/best";
const audioOnlyFormat = "bestaudio/best";

const resolutionOptions = [
  {
    value: "best",
    label: "Best available",
    format: formatWithAudioAndVideo,
    previewFormat
  },
  {
    value: "1080",
    label: "1080p or lower",
    height: 1080
  },
  {
    value: "720",
    label: "720p or lower",
    height: 720
  },
  {
    value: "480",
    label: "480p or lower",
    height: 480
  },
  {
    value: "360",
    label: "360p or lower",
    height: 360
  },
  {
    value: "mp3",
    label: "MP3 audio only",
    format: audioOnlyFormat,
    previewFormat,
    downloadType: "audio",
    audioFormat: "mp3",
    audioQuality: "0"
  }
];

const optionsByValue = new Map(resolutionOptions.map((option) => [option.value, option]));

function normalizeResolution(value) {
  const resolution = typeof value === "string" && value.trim() ? value.trim() : "best";
  const option = optionsByValue.get(resolution);

  if (!option) {
    return {
      ok: false,
      message: "Choose a supported resolution."
    };
  }

  return {
    ok: true,
    value: option.value,
    label: option.label,
    height: option.height || null,
    downloadType: option.downloadType || "video",
    audioFormat: option.audioFormat || null,
    audioQuality: option.audioQuality || null,
    format: buildFormatSelector(option),
    previewFormat: buildPreviewFormatSelector(option)
  };
}

function buildFormatSelector(option) {
  if (option.format) {
    return option.format;
  }

  return [
    `best[height<=${option.height}][ext=mp4][vcodec!=none][acodec!=none]`,
    `best[height<=${option.height}][vcodec!=none][acodec!=none]`,
    `best[height<=${option.height}][ext=mp4]`,
    `best[height<=${option.height}]`,
    `best[width<=${option.height}][ext=mp4][vcodec!=none][acodec!=none]`,
    `best[width<=${option.height}][vcodec!=none][acodec!=none]`,
    `best[width<=${option.height}][ext=mp4]`,
    `best[width<=${option.height}]`,
    formatWithAudioAndVideo
  ].join("/");
}

function buildPreviewFormatSelector(option) {
  if (option.previewFormat) {
    return option.previewFormat;
  }

  return [
    `best[height<=${option.height}][ext=mp4][vcodec!=none]`,
    `best[height<=${option.height}][vcodec!=none]`,
    `best[height<=${option.height}][ext=mp4]`,
    `best[height<=${option.height}]`,
    `best[width<=${option.height}][ext=mp4][vcodec!=none]`,
    `best[width<=${option.height}][vcodec!=none]`,
    `best[width<=${option.height}][ext=mp4]`,
    `best[width<=${option.height}]`,
    previewFormat
  ].join("/");
}

module.exports = {
  normalizeResolution,
  resolutionOptions
};
