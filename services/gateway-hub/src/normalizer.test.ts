import { test } from "node:test";
import assert from "node:assert";
import { cleanMessageContent, parseTimestamp } from "./normalizer.js";

test("Sanitizer strips legacy reaction trailing tokens and preserves message text", () => {
  const input = "Xin chào bạn/-strong/-heart:>:o:-((:-h";
  const result = cleanMessageContent(input);

  assert.strictEqual(result.cleanText, "Xin chào bạn");
  assert.strictEqual(result.reactions.length, 4);

  const like = result.reactions.find((r) => r.type === "like");
  assert.ok(like, "Must find like reaction");
  assert.strictEqual(like.emoji, "👍");

  const heart = result.reactions.find((r) => r.type === "heart");
  assert.ok(heart, "Must find heart reaction");
  assert.strictEqual(heart.emoji, "❤️");
});

test("Sanitizer preserves valid URLs and links", () => {
  const input = "Xem video này nhé https://www.tiktok.com/@user/video/123456789 /-heart";
  const result = cleanMessageContent(input);

  assert.strictEqual(result.cleanText, "Xem video này nhé https://www.tiktok.com/@user/video/123456789");
  assert.strictEqual(result.reactions.length, 1);
  assert.strictEqual(result.reactions[0].type, "heart");
});

test("Timestamp parser handles 12h and 24h formats correctly", () => {
  const ts = parseTimestamp("14:35");
  const d = new Date(ts);
  assert.strictEqual(d.getHours(), 14);
  assert.strictEqual(d.getMinutes(), 35);
});
