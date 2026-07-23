const allowedHosts = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com"
]);

const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be"
]);

const facebookHosts = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "mbasic.facebook.com",
  "fb.watch",
  "www.fb.watch"
]);

const instagramHosts = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com"
]);

const vimeoHosts = new Set([
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com"
]);

const tiktokHosts = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com"
]);

function parseVideoUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      message: "Enter a valid supported video URL."
    };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      ok: false,
      message: "The link must use http or https."
    };
  }

  const host = parsed.hostname.toLowerCase();

  if (allowedHosts.has(host)) {
    return parseTweetUrlFromParsedUrl(parsed);
  }

  if (youtubeHosts.has(host)) {
    return parseYoutubeUrlFromParsedUrl(parsed);
  }

  if (facebookHosts.has(host)) {
    return parseFacebookUrlFromParsedUrl(parsed);
  }

  if (instagramHosts.has(host)) {
    return parseInstagramUrlFromParsedUrl(parsed);
  }

  if (vimeoHosts.has(host)) {
    return parseVimeoUrlFromParsedUrl(parsed);
  }

  if (tiktokHosts.has(host)) {
    return parseTiktokUrlFromParsedUrl(parsed);
  }

  return {
    ok: false,
    message:
      "Enter a supported video URL from Twitter/X, YouTube, Facebook, Instagram, Vimeo, or TikTok."
  };
}

function parseTweetUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      message: "Enter a valid Twitter/X tweet URL."
    };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      ok: false,
      message: "The link must use http or https."
    };
  }

  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      message: "Enter a twitter.com or x.com tweet URL."
    };
  }

  return parseTweetUrlFromParsedUrl(parsed);
}

function parseTweetUrlFromParsedUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const statusIndex = parts.findIndex((part) =>
    ["status", "statuses"].includes(part.toLowerCase())
  );
  const tweetId = statusIndex >= 0 ? parts[statusIndex + 1] : undefined;

  if (!tweetId || !/^\d+$/.test(tweetId)) {
    return {
      ok: false,
      message: "The link must point to a specific tweet status."
    };
  }

  return {
    ok: true,
    source: "twitter",
    id: tweetId,
    normalizedUrl: `https://x.com/${parts[0]}/status/${tweetId}`,
    tweetId
  };
}

function parseYoutubeUrlFromParsedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId;

  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = parts[0];
  } else if (parts[0]?.toLowerCase() === "watch") {
    videoId = parsed.searchParams.get("v");
  } else if (["shorts", "embed", "live"].includes(parts[0]?.toLowerCase())) {
    videoId = parts[1];
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
    return {
      ok: false,
      message: "The link must point to a specific YouTube video."
    };
  }

  return {
    ok: true,
    source: "youtube",
    id: videoId,
    normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId
  };
}

function parseFacebookUrlFromParsedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId = parsed.searchParams.get("v");

  if (!videoId && (host === "fb.watch" || host === "www.fb.watch")) {
    videoId = parts[0];
  }

  if (!videoId) {
    videoId = getSegmentAfter(parts, ["reel", "reels", "videos"]);
  }

  if (!videoId) {
    const shareIndex = parts.findIndex((part) => part.toLowerCase() === "share");
    const shareType = parts[shareIndex + 1]?.toLowerCase();

    if (shareIndex >= 0 && ["r", "reel", "v", "video"].includes(shareType)) {
      videoId = parts[shareIndex + 2];
    }
  }

  if (!isPlatformId(videoId, 3)) {
    return {
      ok: false,
      message: "The link must point to a specific Facebook video or reel."
    };
  }

  return {
    ok: true,
    source: "facebook",
    id: videoId,
    normalizedUrl: parsed.toString(),
    facebookId: videoId
  };
}

function parseInstagramUrlFromParsedUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const contentType = parts[0]?.toLowerCase();
  let shortcode;

  if (["p", "reel", "reels", "tv"].includes(contentType)) {
    shortcode = parts[1];
  } else if (contentType === "stories" && parts[1] && parts[2]) {
    shortcode = `${parts[1]}-${parts[2]}`;
  }

  if (!isPlatformId(shortcode, 3)) {
    return {
      ok: false,
      message: "The link must point to a specific Instagram post, reel, or story."
    };
  }

  return {
    ok: true,
    source: "instagram",
    id: shortcode,
    normalizedUrl: parsed.toString(),
    instagramId: shortcode
  };
}

function parseVimeoUrlFromParsedUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId;

  if (parsed.hostname.toLowerCase() === "player.vimeo.com") {
    videoId = getSegmentAfter(parts, ["video"]);
  } else {
    videoId = parts.find((part) => /^\d+$/.test(part));
  }

  if (!videoId) {
    return {
      ok: false,
      message: "The link must point to a specific Vimeo video."
    };
  }

  return {
    ok: true,
    source: "vimeo",
    id: videoId,
    normalizedUrl: parsed.toString(),
    vimeoId: videoId
  };
}

function parseTiktokUrlFromParsedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId;

  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    videoId = parts[0];
  } else {
    videoId = getSegmentAfter(parts, ["video"]);

    if (!videoId && parts[0]?.toLowerCase() === "t") {
      videoId = parts[1];
    }

    if (!videoId && parts[0]?.toLowerCase() === "embed" && parts[1]?.toLowerCase() === "v2") {
      videoId = parts[2];
    }
  }

  if (!isPlatformId(videoId, 4)) {
    return {
      ok: false,
      message: "The link must point to a specific TikTok video."
    };
  }

  return {
    ok: true,
    source: "tiktok",
    id: videoId,
    normalizedUrl: parsed.toString(),
    tiktokId: videoId
  };
}

function getSegmentAfter(parts, names) {
  const index = parts.findIndex((part) => names.includes(part.toLowerCase()));

  return index >= 0 ? parts[index + 1] : undefined;
}

function isPlatformId(value, minLength) {
  return typeof value === "string" && new RegExp(`^[a-zA-Z0-9._-]{${minLength},}$`).test(value);
}

module.exports = {
  parseVideoUrl,
  parseTweetUrl
};
