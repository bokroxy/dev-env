import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { tempDir } from "./fixtures.ts";
import { LineTailer, LONG_LINE_PREFIX, readTailLines } from "./tail.ts";

function tmpFile(name = "events.jsonl"): string {
  const dir = tempDir("agent-view-tail-");
  return path.join(dir, name);
}

test("tail returns nothing when the file does not exist and never throws", () => {
  const tailer = new LineTailer(
    path.join(os.tmpdir(), "agent-view-missing", "events.jsonl"),
  );
  assert.deepEqual(tailer.poll(), []);
});

test("tail buffers a partial last line across polls", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file);
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  assert.deepEqual(tailer.poll(), ['{"a":1}']);
  fs.appendFileSync(file, '2}\n{"c":3}\n');
  assert.deepEqual(tailer.poll(), ['{"b":2}', '{"c":3}']);
  assert.deepEqual(tailer.poll(), []);
});

test("tail resets when the file is truncated", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file);
  fs.writeFileSync(file, "first\nsecond\n");
  assert.deepEqual(tailer.poll(), ["first", "second"]);
  fs.writeFileSync(file, "new\n");
  assert.deepEqual(tailer.poll(), ["new"]);
});

test("tail handles rotation (inode replaced by a shorter file)", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file);
  fs.writeFileSync(file, `${"x".repeat(200)}\n`);
  tailer.poll();
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, "rotated\n");
  fs.renameSync(replacement, file);
  assert.deepEqual(tailer.poll(), ["rotated"]);
});

test("tail resets when the path is replaced by a file of the same size", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file);
  fs.writeFileSync(file, "aaaaaaaa\n");
  assert.deepEqual(tailer.poll(), ["aaaaaaaa"]);
  // Rotation to a file that is at least as large as the old offset: only the
  // inode reveals it, a size comparison does not.
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, "bbbbbbbb\n");
  fs.renameSync(replacement, file);
  assert.deepEqual(tailer.poll(), ["bbbbbbbb"]);
});

test("a short read advances the offset by the bytes read, not by the stat size", (t) => {
  // A sysfs file reports 4096 bytes and reads a handful: the real, deterministic
  // short read that a shrinking file produces in the wild. The file is not
  // present on every host (containers, non-Linux), so the test skips there
  // instead of hard-failing before its precondition.
  const file = "/sys/devices/system/cpu/online";
  if (!fs.existsSync(file)) {
    t.skip(`${file} is not present on this host`);
    return;
  }
  const stat = fs.statSync(file);
  const buffer = Buffer.allocUnsafe(stat.size);
  const fd = fs.openSync(file, "r");
  let read: number;
  try {
    read = fs.readSync(fd, buffer, 0, stat.size, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(read < stat.size, `precondition: ${read} < ${stat.size}`);
  const tailer = new LineTailer(file);
  const lines = tailer.poll();
  assert.equal(tailer.bytesRead, read);
  assert.equal(tailer.position, read);
  assert.deepEqual(
    lines.join("\n"),
    buffer.subarray(0, read).toString("utf8").replace(/\n$/, ""),
  );
});

test("an over-long line is kept as a bounded prefix and the rest is still parsed", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file, { maxLine: 1024 });
  fs.writeFileSync(file, `${"y".repeat(60 * 1024)}\nok\n`);
  const lines = tailer.poll();
  assert.equal(lines.length, 2);
  // The over-long line is kept as a bounded prefix so `type`/`toolName` remain
  // recoverable; it is no longer dropped outright.
  assert.equal(tailer.truncatedLongLines, 1);
  assert.equal(lines[0], "y".repeat(LONG_LINE_PREFIX));
  assert.equal(lines.at(-1), "ok");
});

test("tail keeps a bounded window and reports recent lines", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file, { windowSize: 25 });
  const lines = Array.from({ length: 1000 }, (_, index) => `{"n":${index}}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  assert.equal(tailer.poll().length, 1000);
  assert.equal(tailer.recent().length, 25);
  assert.equal(tailer.recent().at(-1), '{"n":999}');
});

test("tail survives a multi-byte character split across writes", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file);
  const bytes = Buffer.from("é\n", "utf8");
  fs.writeFileSync(file, bytes.subarray(0, 1));
  assert.deepEqual(tailer.poll(), []);
  fs.appendFileSync(file, bytes.subarray(1));
  assert.deepEqual(tailer.poll(), ["é"]);
});

test("tail skips to the end of a huge append instead of reading it all", () => {
  const file = tmpFile();
  const tailer = new LineTailer(file, { maxChunkBytes: 4096 });
  fs.writeFileSync(file, `${"z".repeat(100 * 1024)}\nlast\n`);
  const lines = tailer.poll();
  assert.equal(lines.at(-1), "last");
  assert.ok(
    tailer.bytesRead <= 4096,
    `bytes read ${tailer.bytesRead} should stay bounded`,
  );
});

test("readTailLines returns the last lines from a bounded read", () => {
  const file = tmpFile("output-0.log");
  fs.writeFileSync(
    file,
    Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n") +
      "\n",
  );
  assert.deepEqual(readTailLines(file, 3), [
    "line 197",
    "line 198",
    "line 199",
  ]);
  const bounded = readTailLines(file, 3, 40);
  assert.equal(bounded.length, 3);
  assert.equal(bounded.at(-1), "line 199");
  assert.deepEqual(
    readTailLines(path.join(os.tmpdir(), "agent-view-missing.log"), 3),
    [],
  );
});
