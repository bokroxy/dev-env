import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateColumns, splitSystemPrompt } from "./breakdown.ts";

test("allocateColumns fills the width proportionally", () => {
  assert.deepEqual(allocateColumns([50, 30, 20], 10), [5, 3, 2]);
  assert.equal(
    allocateColumns([1, 2, 3, 4], 37).reduce((a, b) => a + b, 0),
    37,
  );
});

test("allocateColumns keeps tiny non-zero segments visible", () => {
  const cols = allocateColumns([1, 10_000, 0], 20);
  assert.equal(cols[0], 1);
  assert.equal(cols[2], 0);
  assert.equal(
    cols.reduce((a, b) => a + b, 0),
    20,
  );
});

test("allocateColumns handles empty input", () => {
  assert.deepEqual(allocateColumns([0, 0], 10), [0, 0]);
  assert.deepEqual(allocateColumns([5], 0), [0]);
});

test("splitSystemPrompt separates project context and skills", () => {
  const context = "<project_context>\nAGENTS rules\n</project_context>";
  const skills = "<skills>\nskill list\n</skills>";
  const prompt = `preamble text\n\n${context}\n\n${skills}\n\n<cwd>\n/home\n</cwd>`;
  const split = splitSystemPrompt(prompt);
  assert.equal(split.contextFiles, Math.ceil(context.length / 4));
  assert.equal(split.skills, Math.ceil(skills.length / 4));
  assert.equal(
    split.system,
    Math.ceil((prompt.length - context.length - skills.length) / 4),
  );
});

test("splitSystemPrompt ignores a <skills> tag quoted inside AGENTS.md", () => {
  const prompt =
    "base\n<project_context>\nsee <skills>\nnot real\n</skills> here\n</project_context>";
  assert.equal(splitSystemPrompt(prompt).skills, 0);
});
