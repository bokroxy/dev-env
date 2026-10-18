import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tempDir as makeTempDir } from "./fixtures.ts";
import { DurationBook, PersonaStore, PERSONA_TTL_MS } from "./history.ts";

function tempDir(): string {
  return makeTempDir("agent-view-history-");
}

test("duration book round-trips through the file and reports the median", () => {
  const dir = tempDir();
  const file = path.join(dir, "durations.json");
  const now = 1_000_000_000;
  const book = new DurationBook(file, () => now);
  assert.equal(book.record("impl", "run-1", 60_000), true);
  assert.equal(book.record("impl", "run-2", 120_000), true);
  // Two samples are still noise: one short run must never decide the estimate.
  assert.equal(book.medianMs("impl"), undefined);
  assert.equal(book.record("review", "run-3", 30_000), true);
  assert.equal(book.record("impl", "run-4", 90_000), true);
  // A fourth sample makes the count even: the median is the mean of the middle
  // two, not either one of them.
  assert.equal(book.record("impl", "run-5", 150_000), true);
  assert.equal(book.save(), true);
  assert.equal(fs.existsSync(file), true);

  const reloaded = new DurationBook(file, () => now);
  // [60k, 90k, 120k, 150k] -> (90k + 120k) / 2.
  assert.equal(reloaded.medianMs("impl"), 105_000);
  // A single sample survives the reload and is still not a median.
  assert.equal(reloaded.samples("review"), 1);
  assert.equal(reloaded.medianMs("review"), undefined);
  assert.equal(reloaded.medianMs("clef"), undefined);
});

test("the same run is never recorded twice", () => {
  const dir = tempDir();
  const file = path.join(dir, "durations.json");
  const book = new DurationBook(file, () => 1);
  assert.equal(book.record("impl", "run-1", 1000), true);
  assert.equal(book.record("impl", "run-1", 1000), false);
  assert.equal(book.samples("impl"), 1);
});

test("durations are capped per role and the file is written atomically", () => {
  const dir = tempDir();
  const file = path.join(dir, "durations.json");
  const book = new DurationBook(file, () => 5);
  for (let index = 0; index < 60; index += 1)
    book.record("impl", `run-${index}`, 1000 + index);
  assert.equal(book.samples("impl"), 40);
  book.save();
  assert.equal(fs.existsSync(`${file}.tmp-${process.pid}`), false);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.roles.impl.length, 40);
});

test("invalid durations are ignored", () => {
  const dir = tempDir();
  const book = new DurationBook(path.join(dir, "durations.json"), () => 1);
  assert.equal(book.record("impl", "run", 0), false);
  assert.equal(book.record("impl", "run", -5), false);
  assert.equal(book.record("impl", "run", Number.NaN), false);
  assert.equal(book.samples("impl"), 0);
});

test("persona store round-trips and expires after 24h", () => {
  const dir = tempDir();
  const file = path.join(dir, "personas.json");
  let now = 10_000_000;
  const store = new PersonaStore(file, () => now);
  store.set("run-1", 0, { name: "Aldric", noun: "Builder" });
  store.set("run-1", 1, { name: "Bertram", noun: "Wright" });
  store.set("run-2", 0, { name: "Cecily", noun: "Warden" });
  assert.equal(store.save(), true);

  const reloaded = new PersonaStore(file, () => now);
  assert.deepEqual(reloaded.get("run-1", 0), {
    name: "Aldric",
    noun: "Builder",
  });
  assert.deepEqual(reloaded.get("run-1", 1), {
    name: "Bertram",
    noun: "Wright",
  });
  assert.equal(reloaded.all("run-2").length, 1);

  now += PERSONA_TTL_MS + 1;
  const expired = new PersonaStore(file, () => now);
  assert.equal(expired.get("run-1", 0), undefined);
  assert.equal(expired.all("run-2").length, 0);
});

test("corrupt state files fail soft", () => {
  const dir = tempDir();
  const file = path.join(dir, "personas.json");
  fs.writeFileSync(file, "{not json");
  const store = new PersonaStore(file, () => 1);
  assert.equal(store.get("x", 0), undefined);
  store.set("x", 0, { name: "Aldric", noun: "Builder" });
  assert.equal(store.save(), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")).entries.x.ranks["0"],
    { name: "Aldric", noun: "Builder" },
  );
});
