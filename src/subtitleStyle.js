const defaultSubtitleStyle = Object.freeze({
  position: "bottom-center",
  fontSize: 18,
  color: "#FFFFFF"
});

const subtitlePositions = Object.freeze({
  "bottom-left": 1,
  "bottom-center": 2,
  "bottom-right": 3,
  // FFmpeg's SRT force_style path uses the legacy SSA alignment values.
  "top-left": 5,
  "top-center": 6,
  "top-right": 7,
  "middle-left": 9,
  "middle-center": 10,
  "middle-right": 11
});

function normalizeSubtitleStyle(value = {}) {
  const position = Object.prototype.hasOwnProperty.call(
    subtitlePositions,
    value?.position
  )
    ? value.position
    : defaultSubtitleStyle.position;
  const requestedSize = Number(value?.fontSize);
  const fontSize = Number.isFinite(requestedSize)
    ? Math.max(12, Math.min(72, Math.round(requestedSize)))
    : defaultSubtitleStyle.fontSize;
  const color = /^#[0-9a-f]{6}$/i.test(String(value?.color || ""))
    ? String(value.color).toUpperCase()
    : defaultSubtitleStyle.color;

  return { position, fontSize, color };
}

function getSubtitleRenderStyle(style) {
  const normalized = normalizeSubtitleStyle(style);

  return {
    ...normalized,
    alignment: subtitlePositions[normalized.position],
    primaryColour: hexColorToAss(normalized.color),
    marginV: normalized.position.startsWith("middle-") ? 0 : 24,
    marginL: 32,
    marginR: 32
  };
}

function hexColorToAss(color) {
  const normalized = normalizeSubtitleStyle({ color }).color.slice(1);
  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);

  return `&H00${blue}${green}${red}`;
}

module.exports = {
  defaultSubtitleStyle,
  getSubtitleRenderStyle,
  hexColorToAss,
  normalizeSubtitleStyle,
  subtitlePositions
};
