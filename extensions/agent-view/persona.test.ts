import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  detectRole,
  NAME_POOL,
  PersonaBook,
  personaId,
  RANKS,
  rankIndex,
  roleOf,
} from "./persona.ts";
import { tempDir } from "./source/fixtures.ts";
import { PersonaStore } from "./source/history.ts";

const pool = ["Aldric", "Bertram", "Cecily", "Dunstan"];

test("role detection follows the child key prefix first, then the agent name", () => {
  assert.equal(detectRole("impl-AF1", "worker"), "impl");
  assert.equal(detectRole("fix-B8d-3", "worker"), "fix");
  assert.equal(detectRole("review-B8d-4", "delegate"), "review");
  assert.equal(detectRole("research-agent-view", "researcher"), "research");
  assert.equal(detectRole("clef-1-blocker", "clef"), "clef");
  assert.equal(detectRole("anything", "reviewer"), "review");
  assert.equal(detectRole("anything", "clef"), "clef");
  assert.equal(detectRole("unknown-key", "mystery-agent"), "delegate");
  assert.equal(roleOf("nonsense").label, "retainer");
});

test("rank thresholds are 25/50/75 percent", () => {
  assert.equal(rankIndex(0), 0);
  assert.equal(rankIndex(0.24), 0);
  assert.equal(rankIndex(0.25), 1);
  assert.equal(rankIndex(0.49), 1);
  assert.equal(rankIndex(0.5), 2);
  assert.equal(rankIndex(0.7499), 2);
  assert.equal(rankIndex(0.75), 3);
  assert.equal(rankIndex(1), 3);
  assert.equal(RANKS.length, 4);
  assert.deepEqual(
    RANKS.map((rank) => rank.glyph),
    ["♙", "♘", "♞", "♛"],
  );
});

test("persona ids separate workflow children from steps of one run", () => {
  assert.equal(personaId("run-1", "run-1"), "run-1");
  assert.equal(personaId("run-1", "impl-AF1"), "run-1::impl-AF1");
  assert.equal(personaId("run-1", "run-1:2"), "run-1::run-1:2");
  assert.equal(personaId("", "planned-child"), "planned-child");
});

test("chain steps of one run get distinct personas", () => {
  const book = new PersonaBook(undefined, pool, 5);
  const first = book.persona("run-c", "run-c:0", "impl", 0);
  const second = book.persona("run-c", "run-c:1", "worker", 0);
  assert.notEqual(first.name, second.name);
});

test("a promotion draws a different name for the same agent", () => {
  const book = new PersonaBook(undefined, pool, 9);
  const page = book.persona("run-p", "impl-P", "impl", 0);
  const squire = book.persona("run-p", "impl-P", "impl", 1);
  assert.notDeepEqual(page, squire);
  assert.deepEqual(book.persona("run-p", "impl-P", "impl", 0), page);
});

test("the name pool is unique and long", () => {
  assert.equal(new Set(NAME_POOL).size, NAME_POOL.length);
  assert.ok(NAME_POOL.length >= 100, `pool size ${NAME_POOL.length}`);
});

test("1000 draws never repeat a name while the pool lasts", () => {
  const book = new PersonaBook(undefined, pool, 42);
  const drawn: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    drawn.push(book.persona(`run-${index}`, `key-${index}`, "impl", 0).name);
  }
  assert.equal(new Set(drawn.slice(0, pool.length)).size, pool.length);
  // Past the pool the numeral suffix starts and names stay distinguishable.
  assert.match(drawn[pool.length], / II$/);
  assert.equal(new Set(drawn).size, drawn.length);
});

test("the same (run, rank) keeps its name and noun", () => {
  const book = new PersonaBook(undefined, pool, 7);
  const first = book.persona("run-a", "impl-1", "impl", 1);
  const again = book.persona("run-a", "impl-1", "impl", 1);
  assert.deepEqual(first, again);
  assert.ok(roleOf("impl").nouns.includes(first.noun), first.noun);
});

test("a persisted persona survives a reopen", () => {
  const dir = tempDir("agent-view-persona-");
  const file = path.join(dir, "personas.json");
  const store = new PersonaStore(file, () => 1_000);
  const first = new PersonaBook(store, pool, 3);
  const persona = first.persona("run-z", "impl-AF1", "impl", 2);
  store.save();

  const reopened = new PersonaBook(
    new PersonaStore(file, () => 1_000),
    pool,
    99,
  );
  assert.deepEqual(reopened.persona("run-z", "impl-AF1", "impl", 2), persona);
});

test("a persisted name already taken by a live agent is replaced", () => {
  const dir = tempDir("agent-view-persona-");
  const store = new PersonaStore(path.join(dir, "personas.json"), () => 1_000);
  store.set("run-a", 0, { name: "Aldric", noun: "Builder" });
  store.set("run-b", 0, { name: "Aldric", noun: "Warden" });
  const book = new PersonaBook(store, pool, 11);
  const first = book.persona("run-a", "impl-A", "impl", 0);
  const second = book.persona("run-b", "review-B", "review", 0);
  assert.notEqual(first.name, second.name);
  assert.equal(new Set(book.liveNames()).size, book.liveNames().length);
});
