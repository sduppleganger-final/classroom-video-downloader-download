const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTweetUrl, parseVideoUrl } = require("../src/twitterUrl");

test("accepts x.com tweet URLs as supported video URLs", () => {
  const result = parseVideoUrl("https://x.com/example/status/1234567890?s=20");

  assert.equal(result.ok, true);
  assert.equal(result.source, "twitter");
  assert.equal(result.id, "1234567890");
  assert.equal(result.tweetId, "1234567890");
  assert.equal(result.normalizedUrl, "https://x.com/example/status/1234567890");
});

test("keeps the tweet-specific parser available", () => {
  const result = parseTweetUrl("https://twitter.com/example/statuses/9876543210");

  assert.equal(result.ok, true);
  assert.equal(result.source, "twitter");
  assert.equal(result.tweetId, "9876543210");
  assert.equal(result.normalizedUrl, "https://x.com/example/status/9876543210");
});

test("accepts YouTube watch URLs", () => {
  const result = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc");

  assert.equal(result.ok, true);
  assert.equal(result.source, "youtube");
  assert.equal(result.id, "dQw4w9WgXcQ");
  assert.equal(result.videoId, "dQw4w9WgXcQ");
  assert.equal(result.normalizedUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("accepts youtu.be short URLs", () => {
  const result = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=example");

  assert.equal(result.ok, true);
  assert.equal(result.source, "youtube");
  assert.equal(result.id, "dQw4w9WgXcQ");
  assert.equal(result.normalizedUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("accepts YouTube shorts URLs", () => {
  const result = parseVideoUrl("https://youtube.com/shorts/abcDEF_1234");

  assert.equal(result.ok, true);
  assert.equal(result.source, "youtube");
  assert.equal(result.id, "abcDEF_1234");
});

test("accepts YouTube embed URLs", () => {
  const result = parseVideoUrl("https://www.youtube-nocookie.com/embed/abcDEF_1234");

  assert.equal(result.ok, true);
  assert.equal(result.source, "youtube");
  assert.equal(result.id, "abcDEF_1234");
});

test("accepts Facebook watch URLs", () => {
  const result = parseVideoUrl("https://www.facebook.com/watch/?v=123456789");

  assert.equal(result.ok, true);
  assert.equal(result.source, "facebook");
  assert.equal(result.id, "123456789");
});

test("accepts Facebook reel URLs", () => {
  const result = parseVideoUrl("https://www.facebook.com/reel/987654321");

  assert.equal(result.ok, true);
  assert.equal(result.source, "facebook");
  assert.equal(result.id, "987654321");
});

test("accepts fb.watch short URLs", () => {
  const result = parseVideoUrl("https://fb.watch/abcDEF123/");

  assert.equal(result.ok, true);
  assert.equal(result.source, "facebook");
  assert.equal(result.id, "abcDEF123");
});

test("accepts Instagram reel URLs", () => {
  const result = parseVideoUrl("https://www.instagram.com/reel/C0abc_DEF12/");

  assert.equal(result.ok, true);
  assert.equal(result.source, "instagram");
  assert.equal(result.id, "C0abc_DEF12");
});

test("accepts Instagram post URLs", () => {
  const result = parseVideoUrl("https://www.instagram.com/p/C0abc_DEF12/");

  assert.equal(result.ok, true);
  assert.equal(result.source, "instagram");
  assert.equal(result.id, "C0abc_DEF12");
});

test("accepts Vimeo video URLs", () => {
  const result = parseVideoUrl("https://vimeo.com/123456789");

  assert.equal(result.ok, true);
  assert.equal(result.source, "vimeo");
  assert.equal(result.id, "123456789");
});

test("accepts Vimeo player URLs", () => {
  const result = parseVideoUrl("https://player.vimeo.com/video/987654321");

  assert.equal(result.ok, true);
  assert.equal(result.source, "vimeo");
  assert.equal(result.id, "987654321");
});

test("accepts TikTok video URLs", () => {
  const result = parseVideoUrl("https://www.tiktok.com/@teacher/video/7234567890123456789");

  assert.equal(result.ok, true);
  assert.equal(result.source, "tiktok");
  assert.equal(result.id, "7234567890123456789");
});

test("accepts TikTok short URLs", () => {
  const result = parseVideoUrl("https://vm.tiktok.com/ZMabcDEF1/");

  assert.equal(result.ok, true);
  assert.equal(result.source, "tiktok");
  assert.equal(result.id, "ZMabcDEF1");
});

test("rejects unsupported URLs", () => {
  const result = parseVideoUrl("https://example.com/example/status/1234567890");

  assert.equal(result.ok, false);
});

test("rejects profile URLs without a status id", () => {
  const result = parseVideoUrl("https://x.com/example");

  assert.equal(result.ok, false);
});

test("rejects YouTube URLs without a video id", () => {
  const result = parseVideoUrl("https://www.youtube.com/playlist?list=abc");

  assert.equal(result.ok, false);
});

test("rejects platform profile URLs without a video id", () => {
  const urls = [
    "https://www.facebook.com/example",
    "https://www.instagram.com/example/",
    "https://vimeo.com/channels/staffpicks",
    "https://www.tiktok.com/@teacher"
  ];

  for (const url of urls) {
    assert.equal(parseVideoUrl(url).ok, false, url);
  }
});
