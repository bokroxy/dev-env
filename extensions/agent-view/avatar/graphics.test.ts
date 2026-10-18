import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCapabilities,
  setCapabilities,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  getKittyImageMetadata,
  getKittyImagePlacement,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildFixtureWorld, tempDir } from "../source/fixtures.ts";
import { createAvatarEngine } from "./poses.ts";
import { createStyles } from "../ui/style.ts";
import { fakeTheme, mountHarness, stripAnsi } from "../harness.ts";
import { WatchImageFrame } from "../tools/image-frame.ts";
import { cropImageRows } from "../ui/text.ts";

const style = createStyles(fakeTheme(), {
  noColor: false,
  reducedMotion: false,
}).halfBlock;

test("Ghostty/Kitty avatars use a real high-resolution PNG with the same cell footprint", async () => {
  const before = getCapabilities();
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const avatar = await createAvatarEngine({ style, graphics: true });
    assert.ok(avatar);
    const rows = avatar.rows("Cecily", "happy", 14);
    assert.equal(avatar.graphics, true);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => visibleWidth(row) === 14));
    assert.match(rows[0], /\x1b_Ga=T,f=100,q=2,C=1/);
    assert.ok((getKittyImageMetadata(rows[0])?.widthPx ?? 0) >= 224);
    assert.strictEqual(
      avatar.rows("Cecily", "happy", 14),
      rows,
      "PNG and encoded row are cached",
    );
    assert.equal(avatar.rasterCount, 1);
    const cropped = cropImageRows(rows.slice(0, 3));
    assert.match(cropped[0], /r=3/);
    assert.equal(
      cropped.length,
      3,
      "an avatar cannot grow the visible body or cover its footer",
    );
    const frame = new WatchImageFrame();
    const first = frame.render(rows);
    const second = frame.render(rows);
    assert.match(first.lines[0], /a=T/);
    assert.match(second.lines[0], /a=p/);
    assert.ok(
      second.lines[0].length < first.lines[0].length / 10,
      "frames reuse the upload",
    );
    assert.ok(frame.dispose().includes("d=A"));
    assert.equal(frame.dispose(), "");
  } finally {
    setCapabilities(before);
  }
});

test("unsupported terminals and explicit opt-out keep the half-block fallback", async () => {
  const before = getCapabilities();
  setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  try {
    const avatar = await createAvatarEngine({ style, graphics: true });
    assert.ok(avatar);
    const rows = avatar.rows("Cecily", "thinking", 14);
    assert.equal(avatar.graphics, false);
    assert.ok(rows.join("").includes("▀") || rows.join("").includes("▄"));
    assert.ok(!rows.join("").includes("\x1b_G"));
  } finally {
    setCapabilities(before);
  }
});

test("native avatar frames fit narrow, normal, and wide viewports without covering the footer", async () => {
  const before = getCapabilities();
  const base = tempDir("agent-view-native-frame-");
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const avatar = await createAvatarEngine({ style, graphics: true });
    assert.ok(avatar);
    const root = path.join(base, "runs");
    const now = 1_800_000_000_000;
    const fixture = buildFixtureWorld(root, now);
    for (const width of [70, 120, 160]) {
      const harness = await mountHarness({
        runsDir: root,
        historyDir: path.join(base, "history"),
        sessionFile: fixture.sessionFile,
        width,
        rows: 40,
        now,
      });
      try {
        harness.component.setAvatar(avatar);
        const lines = harness.frame(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.some((line) => line.includes("smooth Kitty avatars")));
        const footer = lines.findIndex((line) =>
          stripAnsi(line).includes("q quit"),
        );
        assert.ok(footer >= 0);
        assert.ok(lines.some((line) => line.includes("\x1b_G")));
        for (const [index, line] of lines.entries()) {
          const image = getKittyImagePlacement(line);
          if (image) {
            const controls = line.match(/\x1b_G([^;]*);/)?.[1] ?? "";
            const imageRows = Number(
              controls.match(/(?:^|,)r=(\d+)(?:,|$)/)?.[1],
            );
            assert.ok(Number.isFinite(imageRows));
            assert.ok(
              index + imageRows <= footer,
              "an avatar stays above the footer",
            );
          }
        }
      } finally {
        harness.dispose();
      }
    }
  } finally {
    setCapabilities(before);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a plain watcher frame never sends graphics cleanup sequences", () => {
  const frame = new WatchImageFrame();
  assert.deepEqual(frame.render(["hello"]), { lines: ["hello"], cleanup: "" });
  assert.equal(frame.dispose(), "");
});
