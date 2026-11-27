import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCustomWebcastUrl } from "./normalizeCustomWebcastUrl.ts";

test("normalizes YouTube watch URLs and retains a numeric start offset", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=42"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42",
  );
});

test("normalizes youtu.be share URLs", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://youtu.be/dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  );
});

test("normalizes YouTube live URLs", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://www.youtube.com/live/dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  );
});

test("normalizes YouTube shorts URLs", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://youtube.com/shorts/dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  );
});

test("leaves existing YouTube embed URLs intact", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://www.youtube.com/embed/dQw4w9WgXcQ?start=12"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?start=12",
  );
});

test("leaves non-YouTube stream URLs unchanged", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://example.com/live/stream.m3u8"),
    "https://example.com/live/stream.m3u8",
  );
});

test("does not rewrite YouTube URLs without a valid video identifier", () => {
  assert.equal(
    normalizeCustomWebcastUrl("https://www.youtube.com/watch?v=short-id"),
    "https://www.youtube.com/watch?v=short-id",
  );
});
