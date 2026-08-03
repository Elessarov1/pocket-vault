import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production page contains the app without review prototype controls", async () => {
  const production = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(production, /class="production-app"/);
  assert.match(production, /id="app-screen"/);
  assert.match(production, /id="screen-onboarding"/);
  assert.doesNotMatch(production, /class="prototype-layout"/);
  assert.doesNotMatch(production, /class="review-panel"/);
  assert.doesNotMatch(production, /id="screen-picker"/);
  assert.doesNotMatch(production, /class="device-shell"/);
});

test("review page embeds the production app and owns all review controls", async () => {
  const review = await readFile(new URL("../review.html", import.meta.url), "utf8");

  assert.match(review, /class="prototype-layout"/);
  assert.match(review, /class="review-panel"/);
  assert.match(review, /id="screen-picker"/);
  assert.match(review, /src="index\.html\?preview=1"/);
  assert.doesNotMatch(review, /id="screen-onboarding"/);
  assert.doesNotMatch(review, /id="app-screen"/);
});
