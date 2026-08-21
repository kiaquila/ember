import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
for (const id of ["no-deploy", "static-cloudflare", "next-cloudflare", "static-vercel", "custom-production"]) {
  test(`profile ${id} is self-identifying and contains no secret values`, () => {
    const text = readFileSync(resolve(root, `.web-design/profiles/${id}.json`), "utf8");
    const profile = JSON.parse(text);
    assert.equal(profile.id, id);
    assert.equal(typeof profile.deploymentProvider, "string");
    assert.doesNotMatch(text, /api[_-]?token|private[_-]?key|account[_-]?id/i);
  });
}
